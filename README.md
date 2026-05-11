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

Browsers block access to the camera, microphone, and screen share on non-secure origins. Because this app uses WebRTC for video, audio, and screen share, **it must be served over HTTPS** — even on your local network.

### Create a self-signed certificate

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 365 \
  -keyout certs/dev-key.pem \
  -out certs/dev-cert.pem \
  -subj "/CN=<your-machine>.local" \
  -addext "subjectAltName = IP:<your-machine-ip>"
```

Replace `<your-machine>.local` with your machine's hostname (e.g. `joey-mini.local`) and `<your-machine-ip>` with its LAN IP (e.g. `192.168.1.10`).

Point the server at the certs via environment variables (see below). The browser will warn about the self-signed cert on first visit — proceed past it and the warning won't reappear.

### Trust the cert (optional but recommended)

On macOS, add the cert to your keychain so the browser stops warning:

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain certs/dev-cert.pem
```

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

---

# Docker / Kubernetes (k3d)

The included scripts build a Docker image and load it into a local [k3d](https://k3d.io) cluster.

## Build and import into k3d

```bash
bun run docker-build
# or directly:
./docker-build-k3d.sh
```

This will:
1. Bump the patch version in `package.json`
2. Update the image tag in `charts/web/deployment.yaml`
3. Build the Docker image (`local/chat-web:<version>`)
4. Import the image into the k3d cluster named `local`

## Deploy to local cluster

```bash
bun run local-deploy
```

Applies `charts/web/deployment.yaml` to the `default` namespace of the `k3d-local` context.

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
