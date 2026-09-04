# MathDuel relay

Optional WebSocket relay used only when two players cannot open a direct WebRTC
connection (strict NAT, VPN, UDP blocked). A Cloudflare Worker with one Durable
Object per room code forwards opaque text frames between the host and the guest.
It stores nothing and never parses game messages.

## Deploy (once)

```bash
cd relay
npx wrangler login          # opens a browser, one time
npx wrangler deploy         # prints https://mathduel-relay.<your-subdomain>.workers.dev
```

Then put that URL (as `wss://…`) into `src/config.js` at the repo root, commit, push.
The Pages deploy picks it up and the game falls back to the relay automatically.

## Local test

```bash
cd relay && npx wrangler dev --port 8790
```

Set `RELAY_URL = 'ws://localhost:8790'` in `src/config.js` while testing.

## Limits baked in

- Only origins listed in `ALLOWED_ORIGINS` (wrangler.toml) may connect.
- One host + one guest per room; a lone host is dropped after 15 minutes.
- Frames over 4 KB or more than ~20/s per socket are dropped / disconnect the sender.
- Clients cannot forge `{"sys":…}` control frames.
