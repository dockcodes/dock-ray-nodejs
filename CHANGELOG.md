# Changelog

## 1.1.1

- Remove inventory site URL configuration; use the existing environment setting.
- Separate inventory scheduling by project and normalized environment.

## 1.1.0 - 2026-10-11

- Added opt-in production npm inventory and known-vulnerability reporting.
- Added automatic hourly checks for the Node client, manual reporting and a cron CLI.
- Added package exclusions, private state, cross-process locking and bounded HTTPS delivery.
- Preserved browser/edge entry points without Node-only inventory dependencies.
- Fixed full-Node event ID generation on Node 18 without global Web Crypto.
