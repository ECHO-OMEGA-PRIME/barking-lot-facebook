> ## ✅ TESTED AND TRANSFERRED
>
> This repository has been consolidated into the canonical account. All code, fixes, tests, and
> documentation now live at:
>
> **→ https://github.com/echoomegaprime/barking-lot-facebook**
>
> - Destination commit: `1f94c00a201ae3a8f3724ca4f6f69b535dbf30d1`
> - Cert Forge certificate: `cert_053abafb206b0ccce3b7f3c4c64c7869140e06f3` — `PRODUCTION_READY`
>   (evidence Merkle root `f2d930bce4902b84adc191f843f29c96a140374ba50030c02ca332237bbd0560`,
>   verify at https://cert-api.echosforge.com/v1/certifications/cert_053abafb206b0ccce3b7f3c4c64c7869140e06f3/verdict)
> - GitHub App Suite conformance: manual receipt at
>   [`.echo/repo-health.md`](https://github.com/echoomegaprime/barking-lot-facebook/blob/main/.echo/repo-health.md)
>   in the destination repo (GitHub App Suite auto-posting affected by build #29466 on this
>   account; this is the documented workaround)
> - Transfer date: 2026-08-12
>
> **Security note**: during transfer, two live vulnerabilities were found and fixed in the code
> — an unauthenticated Messenger webhook and an open SSRF in the image proxy. See
> [SECURITY.md in the destination repo](https://github.com/echoomegaprime/barking-lot-facebook/blob/main/SECURITY.md)
> for the full writeup. **The live deployment on this account
> (`barking-lot-facebook.bmcii1976.workers.dev`) has not yet been redeployed with the fix** —
> that URL is hardcoded into this Worker's own widget and is presumably registered as the live
> Messenger webhook in Meta's App dashboard, so redeploying under a different account would
> break the live integration unless coordinated. This is flagged for the Commander, not resolved
> as part of this transfer.
>
> This legacy repository is preserved for provenance and is not actively maintained. Do not
> open issues or PRs here — use the destination repository above.

---

# barking-lot-facebook (legacy)

A Cloudflare Worker connecting The Barking Lot Animal Sanctuary's Facebook Page to their website
and an AI-powered Messenger auto-responder. See the destination repository linked above for
current documentation, tests, and security fixes.
