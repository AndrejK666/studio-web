//! How many tokens a provider's answer cost, read off the answer as it streams
//! past (issue #781).
//!
//! The proxy passes a provider's answer through untouched; this watches the
//! same bytes on their way and keeps the usage the provider reports. Every
//! provider states it in the answer itself, so nothing is estimated:
//!
//! | Answer | Where the usage is |
//! |---|---|
//! | Anthropic Messages, streamed | `message_start.message.usage` (input, cache), then `message_delta.usage.output_tokens`, cumulative |
//! | Anthropic Messages, whole | `usage` |
//! | OpenAI chat completions, streamed | the last chunk's `usage` — only when the request asked for it (`stream_options.include_usage`, which [`super::providers::Providers::chat`] sets) |
//! | OpenAI chat completions, whole | `usage` |
//! | OpenAI Responses (Codex), streamed | `response.completed`'s `response.usage` |
//! | OpenAI Responses, whole | `usage` |
//!
//! Each field is kept at the largest value seen, which is right for all of
//! them: Anthropic repeats and grows its counts across events, and the others
//! state them once.
//!
//! The two providers count cached input differently. Anthropic's
//! `input_tokens` excludes what was read from or written to the cache, and
//! names those separately; OpenAI's `prompt_tokens` / `input_tokens` include
//! the cached part and name it in `*_tokens_details.cached_tokens`. [`Tokens`]
//! is Anthropic's shape — uncached input, cache read, cache write, output —
//! because each of those has its own price.
//!
//! Bounded: an answer that is not a stream is held only up to [`WHOLE_LIMIT`]
//! to be read at the end, and a stream's current line only up to
//! [`LINE_LIMIT`]. Past either, the usage of that answer is unknown, never
//! guessed, and the answer itself still passes through whole.

use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::Bytes;
use futures_util::Stream;
use serde_json::Value;

/// The largest answer that is not a stream this reads whole. A completion is
/// kilobytes; a model list or a batch file is not a completion.
pub const WHOLE_LIMIT: usize = 4 * 1024 * 1024;
/// The longest server-sent-event line kept while waiting for its end.
pub const LINE_LIMIT: usize = 1024 * 1024;

/// What one answer cost, in the units a price is quoted in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tokens {
    /// Input not read from the cache nor written to it.
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Tokens {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    fn widen(&mut self, other: Tokens) {
        self.input = self.input.max(other.input);
        self.output = self.output.max(other.output);
        self.cache_read = self.cache_read.max(other.cache_read);
        self.cache_write = self.cache_write.max(other.cache_write);
    }
}

/// The usage an answer reported, and the model that answered.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Reported {
    pub tokens: Tokens,
    /// As the provider names it in the answer — the model that actually
    /// served, which is what is billed, whatever the request asked for.
    pub model: Option<String>,
}

fn count(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn cached(v: &Value, details: &str) -> u64 {
    v.get(details)
        .map(|d| count(d, "cached_tokens"))
        .unwrap_or(0)
}

/// A `usage` object, in either provider's dialect.
pub fn tokens_of(usage: &Value) -> Tokens {
    if usage.get("prompt_tokens").is_some() || usage.get("completion_tokens").is_some() {
        // OpenAI chat completions: the prompt includes its cached part.
        let read = cached(usage, "prompt_tokens_details");
        return Tokens {
            input: count(usage, "prompt_tokens").saturating_sub(read),
            output: count(usage, "completion_tokens"),
            cache_read: read,
            cache_write: 0,
        };
    }
    if usage.get("input_tokens_details").is_some() {
        // OpenAI Responses: the input includes its cached part.
        let read = cached(usage, "input_tokens_details");
        return Tokens {
            input: count(usage, "input_tokens").saturating_sub(read),
            output: count(usage, "output_tokens"),
            cache_read: read,
            cache_write: 0,
        };
    }
    // Anthropic: the cache is named apart from the input.
    Tokens {
        input: count(usage, "input_tokens"),
        output: count(usage, "output_tokens"),
        cache_read: count(usage, "cache_read_input_tokens"),
        cache_write: count(usage, "cache_creation_input_tokens"),
    }
}

/// Whatever usage and model one JSON message carries — a whole answer, or one
/// event of a stream.
fn read_message(v: &Value, into: &mut Reported) {
    // The message itself (a whole answer, an OpenAI chunk, Anthropic's
    // `message_delta`), then the object a stream event wraps
    // (Anthropic's `message_start.message`, OpenAI's `response.completed.response`).
    for holder in [Some(v), v.get("message"), v.get("response")]
        .into_iter()
        .flatten()
    {
        if let Some(usage) = holder.get("usage").filter(|u| u.is_object()) {
            into.tokens.widen(tokens_of(usage));
        }
        if into.model.is_none()
            && let Some(model) = holder.get("model").and_then(Value::as_str)
            && !model.is_empty()
        {
            into.model = Some(model.to_owned());
        }
    }
}

/// The scan of one answer, fed its bytes in order.
pub struct UsageScan {
    stream: bool,
    /// A stream's unfinished line, or a whole answer so far.
    pending: Vec<u8>,
    /// Past a limit: this answer's usage is not going to be known.
    overflowed: bool,
    reported: Reported,
}

impl UsageScan {
    /// `content_type` is the answer's: a server-sent event stream is read
    /// line by line, anything else whole at the end.
    pub fn new(content_type: Option<&str>) -> Self {
        Self {
            stream: content_type.is_some_and(|t| t.starts_with("text/event-stream")),
            pending: Vec::new(),
            overflowed: false,
            reported: Reported::default(),
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        if self.overflowed {
            return;
        }
        if !self.stream {
            if self.pending.len() + chunk.len() > WHOLE_LIMIT {
                self.overflowed = true;
                self.pending = Vec::new();
            } else {
                self.pending.extend_from_slice(chunk);
            }
            return;
        }
        let mut rest = chunk;
        while let Some(end) = rest.iter().position(|b| *b == b'\n') {
            self.pending.extend_from_slice(&rest[..end]);
            let line = std::mem::take(&mut self.pending);
            self.read_line(&line);
            rest = &rest[end + 1..];
        }
        if self.pending.len() + rest.len() > LINE_LIMIT {
            // One line this long is not an event we read; drop it and take
            // up again at the next line.
            self.pending.clear();
        } else {
            self.pending.extend_from_slice(rest);
        }
    }

    fn read_line(&mut self, line: &[u8]) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let Some(data) = line.strip_prefix(b"data:") else {
            return;
        };
        if let Ok(v) = serde_json::from_slice::<Value>(data.trim_ascii_start()) {
            read_message(&v, &mut self.reported);
        }
    }

    /// The usage this answer reported, once it has all gone by. `None` when
    /// it reported none, or could not be read.
    pub fn finish(mut self) -> Option<Reported> {
        if self.overflowed {
            return None;
        }
        if self.stream {
            let last = std::mem::take(&mut self.pending);
            self.read_line(&last);
        } else if let Ok(v) = serde_json::from_slice::<Value>(&self.pending) {
            read_message(&v, &mut self.reported);
        }
        (!self.reported.tokens.is_empty()).then_some(self.reported)
    }
}

/// An answer's body stream, scanned on its way through. `done` is called once
/// with what the scan found: when the stream ends, or when it is dropped
/// first because the client went away — those tokens were spent too.
pub struct Tapped<S> {
    inner: Pin<Box<S>>,
    scan: Option<UsageScan>,
    done: Option<Box<dyn FnOnce(Option<Reported>) + Send>>,
}

impl<S> Tapped<S> {
    pub fn new(
        inner: S,
        scan: UsageScan,
        done: impl FnOnce(Option<Reported>) + Send + 'static,
    ) -> Self {
        Self {
            inner: Box::pin(inner),
            scan: Some(scan),
            done: Some(Box::new(done)),
        }
    }

    fn settle(&mut self) {
        if let (Some(scan), Some(done)) = (self.scan.take(), self.done.take()) {
            done(scan.finish());
        }
    }
}

impl<S, E> Stream for Tapped<S>
where
    S: Stream<Item = Result<Bytes, E>>,
{
    type Item = Result<Bytes, E>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let polled = self.inner.as_mut().poll_next(cx);
        match &polled {
            Poll::Ready(Some(Ok(chunk))) => {
                if let Some(scan) = self.scan.as_mut() {
                    scan.feed(chunk);
                }
            }
            Poll::Ready(None) => self.settle(),
            Poll::Ready(Some(Err(_))) | Poll::Pending => {}
        }
        polled
    }
}

impl<S> Drop for Tapped<S> {
    fn drop(&mut self) {
        self.settle();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use futures_util::StreamExt;

    use super::*;

    fn scan(content_type: &str, chunks: &[&str]) -> Option<Reported> {
        let mut scan = UsageScan::new(Some(content_type));
        for c in chunks {
            scan.feed(c.as_bytes());
        }
        scan.finish()
    }

    /// Claude Code's stream: input and cache at the start, output growing in
    /// the deltas — and an event split across two network reads.
    #[test]
    fn an_anthropic_stream_reports_its_input_cache_and_final_output() {
        let got = scan(
            "text/event-stream; charset=utf-8",
            &[
                "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-5-5\",\"usage\":{\"input_tokens\":12,\"cache_creation_input_tokens\":300,\"cache_read_input_tokens\":4000,\"output_tokens\":1}}}\n\n",
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\n",
                "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_",
                "tokens\":57}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
            ],
        )
        .expect("usage");
        assert_eq!(
            got,
            Reported {
                tokens: Tokens {
                    input: 12,
                    output: 57,
                    cache_read: 4000,
                    cache_write: 300
                },
                model: Some("claude-sonnet-5-5".into()),
            }
        );
    }

    #[test]
    fn an_anthropic_answer_whole_reports_its_usage() {
        let got = scan(
            "application/json",
            &[r#"{"model":"claude-haiku-5-5","usage":{"input_tokens":5,"output_tokens":9}}"#],
        )
        .expect("usage");
        assert_eq!(
            got.tokens,
            Tokens {
                input: 5,
                output: 9,
                ..Tokens::default()
            }
        );
        assert_eq!(got.model.as_deref(), Some("claude-haiku-5-5"));
    }

    /// The IDE's chat: usage only in the last chunk, its cached part inside
    /// the prompt count.
    #[test]
    fn an_openai_chat_stream_reports_the_last_chunks_usage_without_the_cached_part() {
        let got = scan(
            "text/event-stream",
            &[
                "data: {\"model\":\"gpt-4.1-mini\",\"choices\":[{\"delta\":{\"content\":\"a\"}}],\"usage\":null}\r\n\r\n",
                "data: {\"model\":\"gpt-4.1-mini\",\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20,\"prompt_tokens_details\":{\"cached_tokens\":64}}}\r\n\r\n",
                "data: [DONE]\r\n\r\n",
            ],
        )
        .expect("usage");
        assert_eq!(
            got.tokens,
            Tokens {
                input: 36,
                output: 20,
                cache_read: 64,
                cache_write: 0
            }
        );
        assert_eq!(got.model.as_deref(), Some("gpt-4.1-mini"));
    }

    /// Codex: the Responses API's completion event carries the usage.
    #[test]
    fn an_openai_responses_stream_reports_the_completed_events_usage() {
        let got = scan(
            "text/event-stream",
            &[
                "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"model\":\"gpt-5-codex\",\"usage\":null}}\n\n",
                "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-5-codex\",\"usage\":{\"input_tokens\":900,\"input_tokens_details\":{\"cached_tokens\":800},\"output_tokens\":40}}}\n\n",
            ],
        )
        .expect("usage");
        assert_eq!(
            got.tokens,
            Tokens {
                input: 100,
                output: 40,
                cache_read: 800,
                cache_write: 0
            }
        );
        assert_eq!(got.model.as_deref(), Some("gpt-5-codex"));
    }

    /// A model list, an error, a stream that says nothing about usage: no
    /// record, rather than a record of zero.
    #[test]
    fn an_answer_without_usage_reports_none() {
        assert_eq!(
            scan("application/json", &[r#"{"data":[{"id":"m"}]}"#]),
            None
        );
        assert_eq!(scan("application/json", &["not json"]), None);
        assert_eq!(scan("text/event-stream", &["data: {\"x\":1}\n\n"]), None);
    }

    #[test]
    fn an_answer_past_the_limit_is_not_guessed_at() {
        let mut scan = UsageScan::new(Some("application/json"));
        scan.feed(&vec![b' '; WHOLE_LIMIT]);
        scan.feed(br#"{"usage":{"input_tokens":1}}"#);
        assert_eq!(scan.finish(), None);
    }

    /// The bytes pass through unchanged, and the usage is handed on once —
    /// also when the client hangs up before the end.
    #[tokio::test]
    async fn the_tap_passes_every_byte_and_reports_once() {
        let chunks: Vec<Result<Bytes, std::io::Error>> = vec![
            Ok(Bytes::from_static(
                b"data: {\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}\n",
            )),
            Ok(Bytes::from_static(b"\n")),
        ];
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let tapped = Tapped::new(
            futures_util::stream::iter(chunks),
            UsageScan::new(Some("text/event-stream")),
            move |r| sink.lock().unwrap().push(r),
        );
        let body: Vec<u8> = tapped
            .map(|c| c.unwrap().to_vec())
            .collect::<Vec<_>>()
            .await
            .concat();
        assert_eq!(
            body,
            b"data: {\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}\n\n"
        );
        {
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].as_ref().unwrap().tokens.output, 4);
        }

        let reports = Arc::new(Mutex::new(0));
        let counter = Arc::clone(&reports);
        let mut early = Tapped::new(
            futures_util::stream::iter(vec![
                Ok::<_, std::io::Error>(Bytes::from_static(
                    b"data: {\"usage\":{\"output_tokens\":2}}\n",
                )),
                Ok(Bytes::from_static(b"data: more\n")),
            ]),
            UsageScan::new(Some("text/event-stream")),
            move |r| {
                assert_eq!(r.unwrap().tokens.output, 2);
                *counter.lock().unwrap() += 1;
            },
        );
        early.next().await;
        drop(early);
        assert_eq!(*reports.lock().unwrap(), 1);
    }
}
