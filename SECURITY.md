# Security policy

Report suspected vulnerabilities privately using
[GitHub private vulnerability reporting](https://github.com/curlewlabs-com/workers-logs-reader/security/advisories/new).
Include the affected release or commit, reproduction steps and the observed
impact. Keep credentials, account identifiers and log contents out of public
issues.

Curlew Labs maintains this repository; Jeffrey Wall
([jeffwall-curlewlabs](https://github.com/jeffwall-curlewlabs)) is the release
and security contact through GitHub. Reports are reviewed on a best-effort basis
without a guaranteed response time. Fixes target the latest release; older
release lines have no promised backport window.

## Trust boundary

The package makes no call of its own: every request goes through the `fetch` you
pass in, to `api.cloudflare.com`, with the token you pass in as a bearer header.
It never logs the token. Its warnings name time windows, sampling levels and
HTTP statuses, never a response body. An error it throws carries the response
body text Cloudflare sent, which can echo part of the query, a needle included,
so treat a thrown error's message as you would the query. The events it returns
are your Workers' logs, and whatever personal data they carry is yours to
handle.
