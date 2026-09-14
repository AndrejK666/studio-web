//! Browser → session reverse proxy for the Kubernetes driver.
//!
//! A k8s session Pod is a ClusterIP Service with no ingress of its own. The
//! browser reaches it only through here: the frontend nginx forwards
//! `/studio/{id}/…` to the backend, and this handler proxies HTTP *and the
//! WebSocket upgrade* on to the session's Service. Authentication is the
//! session container's own gate (the 256-bit `STUDIO_SESSION_TOKEN`, passed as
//! `?token=` on the first navigation and swapped for an HttpOnly cookie) —
//! exactly as in the Docker path, so this stays a straight passthrough. An
//! unknown id (or a Loopback/Docker session, which the browser opens directly)
//! is a 404.

use axum::body::Body;
use axum::extract::{Extension, Path, Request};
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use uuid::Uuid;

use super::driver::SessionAddress;
use super::rest::Sessions;

/// Hop-by-hop headers must not be forwarded by a proxy (RFC 7230 §6.1). The
/// upgrade dance re-adds `Connection`/`Upgrade` on the synthesized 101.
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

fn strip_hop_by_hop(headers: &mut header::HeaderMap) {
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
}

/// `/studio-session/v1/ide/{id}` — the workspace root (empty rest).
pub async fn ide_proxy_root(
    ext: Extension<Sessions>,
    Path(id): Path<Uuid>,
    req: Request,
) -> Response {
    proxy(ext, id, String::new(), req).await
}

/// `/studio-session/v1/ide/{id}/{*rest}` — every asset/WS path under it.
pub async fn ide_proxy_rest(
    ext: Extension<Sessions>,
    Path((id, rest)): Path<(Uuid, String)>,
    req: Request,
) -> Response {
    proxy(ext, id, rest, req).await
}

async fn proxy(
    Extension(sessions): Extension<Sessions>,
    id: Uuid,
    rest: String,
    mut req: Request,
) -> Response {
    let Some(svc) = sessions.service.as_ref() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "IDE sessions disabled").into_response();
    };
    // Only Kubernetes (Service) sessions are proxied; a Docker (Loopback)
    // session is opened directly by the portal and never reaches here.
    let (host, port) = match svc.proxy_target(id).await {
        Some(SessionAddress::Service { host, port }) => (host, port),
        _ => return (StatusCode::NOT_FOUND, "no such IDE session").into_response(),
    };

    let query = req
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    // Resolve the Kubernetes Service explicitly before handing the request to
    // hyper.  The backend's Tokio resolver already drives the readiness probe;
    // using it here avoids relying on hyper's per-request DNS connector, which
    // can reject otherwise reachable `*.svc.cluster.local` names in minimal
    // runtime images. `SocketAddr` also formats IPv6 addresses with brackets,
    // so the resulting URI remains valid for either address family.
    let resolved = match tokio::net::lookup_host((host.as_str(), port)).await {
        Ok(mut addresses) => match addresses.next() {
            Some(address) => address,
            None => {
                tracing::warn!(%host, port, "studio-session: IDE service DNS returned no addresses");
                return (StatusCode::BAD_GATEWAY, "session service has no address").into_response();
            }
        },
        Err(error) => {
            tracing::warn!(%host, port, %error, "studio-session: IDE service DNS lookup failed");
            return (StatusCode::BAD_GATEWAY, "session service lookup failed").into_response();
        }
    };
    let upstream: Uri = match format!("http://{resolved}/{rest}{query}").parse() {
        Ok(u) => u,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("bad upstream uri: {e}")).into_response();
        }
    };

    // Is this a WebSocket / protocol upgrade? Theia's IDE channel is a WS.
    let is_upgrade = req.headers().contains_key(header::UPGRADE);

    // The client (browser-facing) upgrade future must be taken BEFORE the
    // request is consumed by the upstream call.
    let client_on_upgrade = if is_upgrade {
        Some(hyper::upgrade::on(&mut req))
    } else {
        None
    };
    let upgrade_hdr = req.headers().get(header::UPGRADE).cloned();

    // Rebuild the request for the upstream: same method, upstream uri, headers
    // minus hop-by-hop, original body.
    let (mut parts, body) = req.into_parts();
    parts.uri = upstream;
    strip_hop_by_hop(&mut parts.headers);
    if is_upgrade {
        // Re-assert the upgrade intent on the forwarded request so hyper opens
        // the upstream connection in upgrade mode.
        parts.headers.insert(
            header::CONNECTION,
            header::HeaderValue::from_static("upgrade"),
        );
        if let Some(u) = &upgrade_hdr {
            parts.headers.insert(header::UPGRADE, u.clone());
        }
    }
    let forwarded = Request::from_parts(parts, body);

    let client: Client<_, Body> = Client::builder(TokioExecutor::new()).build_http();
    let mut upstream_resp = match client.request(forwarded).await {
        Ok(r) => r.map(Body::new),
        Err(_e) => {
            // Do not log the URI: the first IDE navigation carries the
            // per-session gate token in its query string.
            tracing::warn!(
                %host,
                port,
                "studio-session: IDE upstream request failed"
            );
            return (StatusCode::BAD_GATEWAY, "session upstream unreachable").into_response();
        }
    };

    if upstream_resp.status() == StatusCode::SWITCHING_PROTOCOLS {
        // Splice the two upgraded connections together and stream bytes both
        // ways until either side closes.
        let upstream_on_upgrade = hyper::upgrade::on(&mut upstream_resp);
        if let Some(client_on_upgrade) = client_on_upgrade {
            tokio::spawn(async move {
                match tokio::try_join!(client_on_upgrade, upstream_on_upgrade) {
                    Ok((client_io, upstream_io)) => {
                        let mut client_io = hyper_util::rt::TokioIo::new(client_io);
                        let mut upstream_io = hyper_util::rt::TokioIo::new(upstream_io);
                        if let Err(e) =
                            tokio::io::copy_bidirectional(&mut client_io, &mut upstream_io).await
                        {
                            tracing::debug!("studio-session: IDE ws proxy closed: {e}");
                        }
                    }
                    Err(e) => tracing::warn!("studio-session: IDE ws upgrade failed: {e}"),
                }
            });
        }
        // Hand the 101 (with the upstream's headers) back to the browser; the
        // spawned task owns the bytes from here.
        let mut resp = Response::builder().status(StatusCode::SWITCHING_PROTOCOLS);
        if let Some(h) = resp.headers_mut() {
            *h = upstream_resp.headers().clone();
        }
        return resp.body(Body::empty()).unwrap_or_else(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, "proxy 101 build failed").into_response()
        });
    }

    // Plain HTTP: strip hop-by-hop from the response and pass it through.
    strip_hop_by_hop(upstream_resp.headers_mut());
    upstream_resp.into_response()
}
