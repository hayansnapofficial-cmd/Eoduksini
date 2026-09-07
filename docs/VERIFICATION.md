# Verification — 2026-09-05

Verification is performed on actual code, not historical PASS claims.

## Local Windows

- Core, demo adapter and Governor tests: run with npm test.
- JavaScript syntax, JSON Schema 2020-12 contracts and adapter boundary: npm run check.
- Runtime bundle: npm run build.
- Locked dependency audit: npm audit (zero findings after Ajv 8.20.0).

## CI

The committed workflow runs the public Core and demo adapter on Windows and Linux. Remote outcomes are reported only after the run finishes.

## Limits

Contract and Semantic Footprint tests do not prove complete language parsing, model calls, distributed write enforcement, production development, actual database operations, cross-node recovery, or Git/DB promotion. These checks do not turn unimplemented production capabilities into claims.
