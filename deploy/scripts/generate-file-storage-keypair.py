"""Generate one file-storage P-256 signing pair.

Both values use RFC 4648 base64url without padding, exactly as gears-rust
decodes them: the private key as PKCS#8 DER, the public key as the 65-byte
uncompressed SEC1 point. Run once for each GitHub Environment; do not commit
the output.
"""

from __future__ import annotations

import base64

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
except ImportError as exc:
    raise SystemExit(
        "Missing dependency. Install it with: py -m pip install cryptography"
    ) from exc


def base64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


key = ec.generate_private_key(ec.SECP256R1())
private_key = key.private_bytes(
    serialization.Encoding.DER,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption(),
)
public_key = key.public_key().public_bytes(
    serialization.Encoding.X962,
    serialization.PublicFormat.UncompressedPoint,
)

print(f"FILE_STORAGE_SIGNING_SEED={base64url(private_key)}")
print(f"FILE_STORAGE_SIDECAR_PUBLIC_KEY={base64url(public_key)}")
