# Portcloud Notify SDKs

Client SDKs for the [Portcloud Notify](https://notify.portcloud.online/docs/) public HTTP
API (`/api/v1/*`), which sends email and ntfy notifications through an account's send
preset. Delivery is asynchronous: a send is accepted with a `log_id`, and the real result
is polled afterwards.

## Python

Source: [`python/`](./python) — distribution `portcloud-notify`, import
`portcloud_notify`, Python >= 3.9, standard library only (no runtime dependencies).

```bash
pip install "git+https://github.com/portcloud-labs/portcloud-notify-sdk.git#subdirectory=python"
```

```python
from portcloud_notify import Client

client = Client()  # reads PORTCLOUD_NOTIFY_API_KEY

accepted = client.send_preset("Deploy done", "Service is live.")
print(accepted.log_id, accepted.status)  # queued — accepted, not delivered
print(client.wait(accepted.log_id).status)
```

See [`python/README.md`](./python/README.md) for the method reference, configuration,
error handling, and asynchronous-delivery semantics.

## Layout

| Path | Contents |
| --- | --- |
| `python/` | Python SDK package (`src/portcloud_notify`), its tests, and its README. |

## Releasing the Python SDK

Publishing uses [PyPI Trusted Publishing](https://docs.pypi.org/trusted-publishers/):
no API token is stored in this repository or in GitHub secrets.

1. On PyPI, add a **pending publisher** for the project `portcloud-notify` with owner
   `portcloud-labs`, repository `portcloud-notify-sdk`, workflow `publish.yml`, and
   environment `pypi`. (Only needed for the first release; afterwards the project exists.)
2. Bump the version in `python/src/portcloud_notify/_version.py`.
3. Push a `v*` tag, or run the `Publish` workflow manually. It runs the test suite, builds
   the wheel and sdist, runs `twine check`, and uploads to PyPI.

Check the artifacts locally before tagging:

```bash
python -m build --outdir dist python && python -m twine check dist/*
```

API keys are created in the Portcloud console; channels and the send preset are account
settings managed there, not by these SDKs. Sending consumes Message Credits, and a POST is
never retried automatically because the API provides no idempotency key.
