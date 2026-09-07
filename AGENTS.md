# Eoduksini development

User requests define the active scope. Read README.md and docs/BOUNDARY.md before changing interfaces.

- Keep project-specific implementations in adapters; public Core must remain product-neutral.
- Core must not import project adapters or embed a project repository, domain, model name, tenant field, or database vendor.
- A project adapter declares paths, commands, and policies. Commands are data; Core does not execute them implicitly.
- Verify changes with npm test, npm run check, and npm run build.
- Never claim an actual model run, distributed lock, merge, deployment, or DB operation based on a contract test.
