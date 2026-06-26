# Dev Chit Chat

In 2009, at the Velocity conference, a couple of guys who worked at Flickr presented how development and operations fits toghether and gets along ... at Flickr.

The premise is kinda of dumb. Like, why was there even a Devs vs Ops mentality? Regardless, it was real. We were all working on systems and under pressure to build stuff that, quite frankly, was hard.

Anyways, that was the inspiration. Since then, I've championed just collaborating with each other as we build things together.

Along with this, Agile had already been getting traction in corporate America. Scrum was being used to run teams. And Daily Standups were becoing the norm.

In 2013 Github released Hubot as open source, it's home grown chat bot.

I was at GameStop at this time, managing my first team. I saw first hand what a DevOps culture felt like. We deployed the system every week. It was amazing.

Dev Chit Chat came out of that experience and time. Developers meeting daily chit chatting about what they were going to do today, what they learned, etc.

# A Story

I want a chat system that works like Discord, but I don't need the scalability of Discord. I'm just using it for my friends, small teams, not 1000 member community.

Bun is fast and javascript is fine. So let's leverage the accessiblity of both to build a small chat system that does video, audio and screenshare live streaming.

I run bun start the first time and I see a bootstrapping invite code in the console. I double-click on it and copy it to pasteboard. Then I visit https://joey-mac-mini.local:3000 (use your machine name instead of mine in hte URL) and enter it on the signup page to create the first account, it's the admin.

Upon signing in the first time, there's no communication hubs or channels. So we need to create the first ones first so the app can be in a useable state.

The system should just create a default hub and channel. That way, on bootstrap, the system is useable right off the bat. I can start chatting in a channel.

---

# Getting Started

## Prerequisites

- [Bun](https://bun.sh) v1.0 or later

## Install

```bash
bun install
```

## HTTPS requirement

Text chat works over plain HTTP. However, browsers block camera, microphone, and screen-share access on non-secure origins, so **HTTPS is required for video and audio calls**.

### Create a self-signed certificate

First, find your machine's hostname and LAN IP:

```bash
# macOS
hostname          # e.g. joey-mac-mini.local
ipconfig getifaddr en0   # e.g. 192.168.1.10

# Linux
hostname -f
hostname -I | awk '{print $1}'
```

Then generate the certificate, substituting your actual hostname and IP:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 365 \
  -keyout certs/dev-key.pem \
  -out certs/dev-cert.pem \
  -subj "/CN=joey-mac-mini.local" \
  -addext "subjectAltName = IP:192.168.1.10"
```

The server looks for `certs/dev-cert.pem` and `certs/dev-key.pem` by default. You can override the paths with `TLS_CERT` and `TLS_KEY` environment variables (see below).

On first visit the browser will warn about the self-signed cert — proceed past it and the warning won't reappear.

### Trust the cert (optional but recommended)

Trusting the cert silences the browser warning permanently.

**macOS:**

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain certs/dev-cert.pem
```

**Linux (Debian/Ubuntu):**

```bash
sudo cp certs/dev-cert.pem /usr/local/share/ca-certificates/devchitchat.crt
sudo update-ca-certificates
```

**Windows:** Double-click `certs/dev-cert.pem`, choose "Install Certificate", place it in the "Trusted Root Certification Authorities" store.

## Start the server

```bash
# Production
bun start

# Development (auto-restarts on file changes)
bun dev
```

The server starts on port `3000` by default. Visit `https://<your-machine>.local:3000`.

## First-time bootstrap

On the very first run, an invite code is printed to the console:

```
Invite code: https://<your-machine>.local:3000/signup?code=<token>
```

Copy that URL and open it in a browser to create the first account, which becomes the admin. From there you can invite other users and set up hubs and channels.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `DB_PATH` | `data/chat.db` | Path to the SQLite database file |
| `NODE_ENV` | `development` | Set to `production` in production |
| `TLS_CERT` | `certs/dev-cert.pem` | Path to the TLS certificate |
| `TLS_KEY` | `certs/dev-key.pem` | Path to the TLS private key |

## Run tests

```bash
bun test
```

## Backup and restore

### Backup

**Database:**

```bash
bun backup
```

Creates a clean binary copy of the database at `data/backups/chat-<timestamp>.db` using SQLite's `VACUUM INTO`. Safe to run against a live server.

| Variable | Default | Description |
|---|---|---|
| `DB_PATH` | `data/chat.db` | Path to the source database |
| `BACKUP_DIR` | `data/backups` | Directory where backups are written |

**Uploads:**

```bash
bun backup-uploads
```

Mirrors the uploads directory to a backup location. Not versioned — overwrites the destination with the current state.

| Variable | Default | Description |
|---|---|---|
| `UPLOAD_DIR` | `data/uploads` | Source uploads directory |
| `UPLOADS_BACKUP_DIR` | `data/backups/uploads` | Backup destination |

### Restore

#### Local (bare Bun process)

**Database:**

1. Stop the server.
2. Copy the backup over the live database:
   ```bash
   cp data/backups/chat-<timestamp>.db data/chat.db
   ```
3. Restart the server.

**Uploads:**

```bash
cp -r data/backups/uploads data/uploads
```

#### Kubernetes (k3s)

**Database:**

```bash
bun restore path/to/chat-<timestamp>.db
```

`scripts/restore.js` handles the full sequence automatically:

1. Switches to the correct kubectl context
2. Scales `chat-web` down to 0 and waits for termination
3. Starts a temporary `busybox` helper pod mounting the `chat-web-sqlite` PVC
4. Uploads the backup file to the pod
5. Moves it into place as `/var/lib/chat/chat.db`
6. Fixes file permissions so the app can write to the restored database
7. Removes stale WAL/SHM files so SQLite opens cleanly
8. Removes the temporary upload file
9. Deletes the helper pod
10. Scales `chat-web` back to 1 and waits for rollout

If any step fails, the helper pod is cleaned up and the deployment is scaled back to 1 before exiting.

**Uploads:**

```bash
bun restore-uploads path/to/uploads-backup
```

Copies the uploads directory into the PVC via a temporary helper pod. The deployment is not scaled down — uploads are static files and the copy is safe against a live server.

**Cluster env vars (both restore scripts):**

| Variable | Default | Description |
|---|---|---|
| `KUBE_CONTEXT` | `k3s-local` | kubectl context |
| `KUBE_NAMESPACE` | `default` | Kubernetes namespace |

#### Useful k8s backup operations

```bash
# Trigger the backup CronJob immediately (instead of waiting for the schedule)
bun backup-now

# Pull backups from the running pod to your local ../backups directory
bun backup-pull
```

---

# Docker / Kubernetes (k3s)

The included scripts build a Docker image and load it into a local [k3s](https://k3s.io) cluster.

## Cluster setup

The cluster runs k3s inside a [Lima](https://lima-vm.io) VM. Lima auto-starts on boot via launchd, so the cluster survives power outages without requiring a user login.

**One-time setup:**

```bash
brew install lima
limactl start --name=k3s template://k3s
```

Merge the kubeconfig so `kubectl` can reach the cluster:

```bash
limactl kubeconfig k3s >> ~/.kube/config
# or set KUBECONFIG directly:
export KUBECONFIG="$HOME/.kube/config:$(limactl list k3s --format '{{.Dir}}/copied-from-guest/kubeconfig.yaml')"
```

The context is named `k3s-local` by default in this project's scripts. Rename it to match if yours differs:

```bash
kubectl config rename-context default k3s-local
```

**Backup paths:**

Lima mounts your home directory into the VM at the same path, so backup paths in `charts/web/values.local.yaml` are regular host paths — no special volume flags needed at cluster creation. Set them in `values.local.yaml` (gitignored):

```yaml
dbBackupNodePath: /Users/yourname/backups/chat-web/db-backups
uploadsBackupNodePath: /Users/yourname/backups/chat-web/uploads-backups
```

## Build and import into k3s

```bash
bun run docker-build
# or directly:
./docker-build-k3s.sh
```

This will:
1. Bump the patch version in `package.json`
2. Update the image tag in `charts/web/deployment.yaml`
3. Build the Docker image (`local/chat-web:<version>`)
4. Import the image into the Lima k3s instance via `limactl shell`

`LIMA_INSTANCE` controls which Lima VM the image is imported into — it maps to the `<name>` in `limactl shell <name>`. If you started your VM with `limactl start --name=k3s`, you never need to set it. Only set it if you named your VM something other than `k3s`:

```bash
LIMA_INSTANCE=my-instance bun run docker-build
```

## Deploy to local cluster

```bash
bun run local-deploy
```

Applies `charts/web/deployment.yaml` to the `default` namespace of the `k3s-local` context.

## Build + deploy in one step

```bash
bun run push
```

## Kubernetes environment variables

Override defaults via `charts/web/deployment.yaml`:

| Variable | Value in chart | Description |
|---|---|---|
| `PORT` | `8080` | Port the container exposes |
| `NODE_ENV` | `production` | Runtime environment |
| `DB_PATH` | `/var/lib/chat/chat.db` | SQLite path (backed by a 2 Gi PVC) |
