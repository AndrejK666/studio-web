# Frame fixture

Proves `MfeHandlerIframe` without any product code: an MFE package whose entry
is a frame, built and served like every other package, mounted by the shell
into the screen area.

It is deliberately a real workspace package. A fixture assembled by hand in the
shell would prove the loader and nothing else; this one proves the whole path —
build, manifest, registry, handler, mount.

Its extension is `placement: hidden` (#318): registered and mountable, but in
no level's rail.

See `docs/adr/0021-an-mfe-entry-may-be-a-frame.md`.
