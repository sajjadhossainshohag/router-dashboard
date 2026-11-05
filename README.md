# Router Dashboard

A dark, live dashboard for the **Mercusys MR60X** (hardware V2.20, firmware 1.x). It shows throughput and router load, lists every device, and lets you block a device, set per-device download/upload speed limits and rename devices. It talks to the router through the same encrypted web API the router's own login page uses.

No npm dependencies. Needs Node.js 20.6 or newer.

## Try it without a router

```
npm run mock   # simulated MR60X
```

Then open http://localhost:3000. `npm test` runs the Mercusys protocol tests against a simulated router.

## Mercusys MR60X

1. Copy `.env.example` to `.env` and set:

   | Variable | Value |
   |---|---|
   | `ROUTER_URL` | The router's address, usually `http://192.168.1.1` (`mwlogin.net` also works) |
   | `ROUTER_PASS` | The password you type on the router's login page |
   | `ROUTER_INSECURE_TLS` | `1` if `ROUTER_URL` is an `https://` Remote Management address |
   | `DASH_USER` / `DASH_PASS` | Login for the dashboard |

2. Run `npm start` on a PC connected to the MR60X's network.

How each feature maps to the router:

| Dashboard | On the router |
|---|---|
| Devices and live speed | The **Clients** list (Network Map) |
| Block | Adds the device to the **Access Control** blacklist (Advanced > Security). Turns Access Control on in blacklist mode if it's off. |
| Speed limit | The router's built-in per-client speed limit, in steps of 1 Kbps |
| Rename | The device name shown in Clients |
| Download/Upload graph | The sum of all clients' live speed (the MR60X doesn't report WAN speed) |

Things to know:

- **One admin session at a time.** The MR60X allows only one logged-in admin. If you open the router's web page while the dashboard runs, the dashboard logs back in and the web page signs you out. Stop the dashboard (Ctrl+C logs it out cleanly) while you use the router's own page.
- **Wrong password:** the dashboard tries once, then stops and tells you, so it doesn't lock the router's login. Fix `.env` and restart.
- **Whitelist mode:** if Access Control is already set to *whitelist*, blocking is refused rather than switching modes, because switching would change who can connect.
- **Blocking** cuts the device off the network entirely, not just from the internet. That's how Mercusys Access Control works.
- **Speed limits** only apply to devices that are connected. If a limit doesn't take effect, Mercusys recommends turning off IPv6 (Advanced > IPv6) and rebooting.
- If your firmware doesn't support per-device limits, the dashboard detects it and shows "Not supported" instead of the controls.

## Notes

- Run the dashboard only on your own network. Router credentials stay on the server and never reach the browser.
- `POLL_MS` sets how often the router is polled (default 3000 ms).
