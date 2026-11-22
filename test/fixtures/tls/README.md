# Remote-image test TLS fixture

These files belong **only** to the deterministic remote-image tests (issue #50).
They are not used by the extension at runtime and are never installed.

- `ca.pem` — a self-signed test CA, trusted by the spawned Pi through
  `NODE_EXTRA_CA_CERTS` only inside the test process.
- `server-cert.pem` / `server-key.pem` — a leaf certificate signed by that CA,
  with `subjectAltName=IP:127.0.0.1,DNS:localhost`, used by the ephemeral local
  HTTPS server in `test/helpers/remote-image-fixture.mjs`.

The CA private key was deliberately removed after signing the leaf: no fixture
needs to issue another certificate at test time. The server key is a throwaway
test key. Do not trust this CA or key outside this repository's tests.
