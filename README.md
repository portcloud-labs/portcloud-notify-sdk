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

## TypeScript

Source: [`typescript/`](./typescript) — package `portcloud-notify`, ESM, Node >= 22,
Cloudflare Workers and Bun, no runtime dependencies.

```bash
npm install portcloud-notify
```

```ts
import { Client } from "portcloud-notify";

const client = new Client(); // reads PORTCLOUD_NOTIFY_API_KEY

const accepted = await client.sendPreset("Deploy done", "Service is live.");
console.log(accepted.logId, accepted.status); // queued — accepted, not delivered
console.log((await client.waitForStatus(accepted.logId)).status);
```

See [`typescript/README.md`](./typescript/README.md) for the method reference,
configuration, error handling, and Cloudflare Workers usage.

## Layout

| Path | Contents |
| --- | --- |
| `python/` | Python SDK package (`src/portcloud_notify`), its tests, and its README. |
| `typescript/` | TypeScript/JavaScript SDK package (`src/`), its tests, and its README. |

## Releasing

Publishing both SDKs uses registry **Trusted Publishing** (OIDC), so no registry token is
stored in this repository or in GitHub secrets. Every update to the **`release`** branch
(and a manual `Publish` run) tests, builds, and uploads both packages:

| Package | Registry | Trigger | Version source |
| --- | --- | --- | --- |
| `portcloud-notify` (Python) | PyPI | push to `release`, or manual run | `python/src/portcloud_notify/_version.py` |
| `portcloud-notify` (npm) | npm | push to `release`, or manual run | `typescript/package.json` |

One-time registry setup:

1. **PyPI** — add a **pending publisher** for the project `portcloud-notify` with owner
   `portcloud-labs`, repository `portcloud-notify-sdk`, workflow `publish.yml`, and
   environment `pypi`. (Only needed for the first release; afterwards the project exists.)
2. **npm** — on npmjs.com add a **Trusted Publisher** for the package `portcloud-notify`
   with the GitHub user/organization `portcloud-labs`, repository
   `portcloud-notify-sdk`, workflow filename `publish.yml`, and environment `npm`.

Release flow:

1. Bump the version in the package you changed (see the table above).
2. Merge to `release`. The workflow runs both jobs; a version that is already published is
   skipped, so a commit that does not bump a version publishes nothing.

Check the artifacts locally before releasing:

```bash
python -m build --outdir dist python && python -m twine check dist/*
(cd typescript && npm ci && npm test && npm pack --dry-run)
```

## License

WTFPL — Do What The Fuck You Want To Public License, Version 2. See [LICENSE](./LICENSE).

API keys are created in the Portcloud console; channels and the send preset are account
settings managed there, not by these SDKs. Sending consumes Message Credits, and a POST is
never retried automatically because the API provides no idempotency key.
