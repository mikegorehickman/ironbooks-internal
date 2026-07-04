# IronBooks — Information Security Policy

| | |
|---|---|
| **Document owner** | _[Name, Title — e.g. Mike Gore-Hickman, Founder]_ |
| **Approved by** | _[Name, Title]_ |
| **Version** | 1.0 |
| **Effective date** | _[YYYY-MM-DD]_ |
| **Last reviewed** | _[YYYY-MM-DD]_ |
| **Review cadence** | At least annually, and after any material change or security incident |
| **Classification** | Internal — may be shared with customers, partners, and auditors under NDA |

---

## 1. Purpose

IronBooks ("the Company") provides cloud-based bookkeeping and financial-reconciliation software for trades businesses, integrating with customers' accounting systems (QuickBooks Online), banking/financial-data providers, and payment processors. We handle sensitive financial data on behalf of our customers and their clients.

This Information Security Policy (ISP) defines the controls, responsibilities, and practices the Company maintains to protect the confidentiality, integrity, and availability (CIA) of that data and the systems that process it. It is the top-level policy from which all other security standards and procedures derive.

## 2. Scope

This policy applies to:

- **All personnel** — employees, contractors, founders, and bookkeepers — who access Company systems or data ("Workforce Members").
- **All systems** that store, process, or transmit Company or customer data, including the production application, databases, source code, CI/CD pipelines, and administrative tooling.
- **All data**, regardless of format or location, owned by or entrusted to the Company.
- **All third parties (sub-processors)** that process Company or customer data on our behalf.

## 3. Roles & Responsibilities

| Role | Responsibility |
|---|---|
| **Security Officer** _(designate a named owner)_ | Owns this policy, the risk register, incident response, vendor reviews, and the annual review. Final authority on security decisions and exceptions. |
| **Engineering** | Builds and operates the application securely; implements controls; performs code review; manages secrets, dependencies, and access. |
| **Workforce Members** | Complete security training, protect credentials and devices, report incidents, and follow this policy and the Acceptable Use Standard. |
| **Vendors / Sub-processors** | Maintain controls at least equivalent to those required herein, governed by contract (DPA/BAA where applicable). |

## 4. Data Classification & Handling

All data is classified into one of four tiers. Handling requirements escalate with sensitivity.

| Tier | Examples | Handling |
|---|---|---|
| **Restricted** | OAuth tokens (QuickBooks, banking), API secrets, Stripe keys, Supabase service-role keys, bank-account numbers, full financial statements | Encrypted in transit and at rest; access on strict least-privilege; never in logs, source code, tickets, or chat; never on local/dev machines except via approved secret managers. |
| **Confidential** | Customer financial transactions, client PII (name, email, phone, address), bookkeeping records, call recordings | Encrypted in transit and at rest; access limited to authorized roles; access logged. |
| **Internal** | Internal docs, non-sensitive configuration, this policy | Access limited to Workforce Members. |
| **Public** | Marketing site, public documentation | No restriction. |

- Customer financial data is processed **only** to deliver the service. It is never sold and never used for unrelated purposes.
- Production data is **not** copied to personal devices, local development environments, spreadsheets, or AI tools outside approved, access-controlled systems.
- Data minimization: we collect and retain only what is required to deliver the service.

## 5. Access Control

- **Least privilege & need-to-know.** Access is granted to the minimum required for a role and revoked when no longer needed.
- **Role-based access control (RBAC).** The application enforces distinct roles (e.g. admin, lead, bookkeeper, billing-only, client, read-only) at the middleware, API, and database (row-level security) layers. A user can access only the customers and functions their role permits.
- **Tenant isolation.** Each customer's data is logically segregated; authorization checks prevent any user from accessing another tenant's data.
- **Administrative access** to production infrastructure (hosting, database, DNS, secret stores, source control) is restricted to named individuals, granted explicitly, and reviewed quarterly.
- **Joiner/Mover/Leaver.** Access is provisioned on hire/role-change and **revoked within 24 hours** of departure or role removal, including all SaaS, source control, infrastructure, and shared credentials.
- **Access reviews** are performed at least quarterly for all production and administrative systems.

## 6. Authentication & Credentials

- **Multi-factor authentication (MFA)** is required for all Workforce accounts on every system that supports it — source control, hosting, database console, email, secret stores, and the administrative application.
- **Customer & staff application authentication** uses passwordless magic-link / SSO; sessions expire and links are single-use and time-limited.
- **No shared accounts.** Each person has an individual identity. Service accounts are documented, owned, and least-privileged.
- **Strong credential hygiene.** Passwords (where used) meet length/complexity standards and are stored in a password manager. Credentials are never reused across systems or shared over chat/email.
- Privileged/break-glass credentials are stored in the secret manager, access-logged, and rotated after use.

## 7. Encryption

- **In transit:** All data is transmitted over TLS 1.2+ (HTTPS). HTTP is redirected to HTTPS; HSTS is enabled. No sensitive data is sent over unencrypted channels.
- **At rest:** All databases, object storage, and backups are encrypted at rest (AES-256 or provider equivalent).
- **Restricted secrets** (OAuth tokens, third-party API keys) are additionally protected via the platform secret manager and/or application-level encryption, and are never stored in source code or client-side code.

## 8. Secrets & Key Management

- All application secrets are stored in a managed secret store (hosting-provider environment variables / secret manager) — **never** committed to source control, hard-coded, or placed in client-side bundles.
- Source control is scanned for committed secrets; any secret that is exposed is **rotated immediately** and the exposure documented as an incident.
- Keys are rotated on a defined schedule and on personnel departure or suspected compromise.
- The database service-role / admin key (which bypasses row-level security) is treated as a Restricted secret: server-side use only, never in browsers, never in local environments, access tightly limited.

## 9. Secure Software Development (SDLC)

- **Code review:** All changes to production code are reviewed before merge (peer review or documented self-review with security checklist for solo-maintained components).
- **Secure defaults:** Authorization is enforced server-side on every endpoint; input is validated; output is encoded; the framework's protections against XSS/CSRF/SQL-injection are used (parameterized queries / ORM, no string-built SQL).
- **Branch protection** on the main branch; no direct force-push; CI must pass before deploy.
- **Dependency management:** Automated dependency and vulnerability scanning (e.g. Dependabot / `npm audit`); high/critical vulnerabilities are remediated within defined SLAs (see §11).
- **Separation of environments:** Development/test environments do not use production data or production credentials.
- **Pre-release security review** for changes that touch authentication, authorization, payments, or data export.

## 10. Infrastructure & Network Security

- Production runs on reputable cloud providers (application hosting, managed Postgres) with their underlying SOC 2 / ISO 27001 controls inherited and documented.
- The database is not publicly exposed beyond authenticated, TLS-protected access; administrative consoles require MFA.
- Principle of least functionality: only required services and ports are enabled.
- Infrastructure changes are made through code/configuration where possible and are change-controlled.

## 11. Vulnerability & Patch Management

- Dependencies and platform components are kept current; security patches are applied promptly.
- **Remediation SLAs:** Critical — 7 days; High — 30 days; Medium — 90 days; Low — best effort, tracked.
- Periodic security testing (at minimum annual external penetration test or equivalent, plus automated scanning) once resources permit; findings tracked to closure.

## 12. Logging, Monitoring & Audit

- Security-relevant events — authentication, administrative actions, access to Restricted/Confidential data, permission changes, and data exports — are logged with actor, timestamp, and context, and retained for at least 12 months.
- An immutable application **audit log** records sensitive operations.
- Logs **must not** contain Restricted data (tokens, secrets, full account numbers).
- Logs are reviewed for anomalies; alerting is configured for high-risk events (e.g. repeated auth failures, privilege changes, mass data access).

## 13. Third-Party / Sub-Processor Management

- A current register of sub-processors is maintained (e.g. cloud hosting, managed database/auth, payment processor, financial-data provider, CRM, email delivery, AI provider). _See Appendix A._
- Each sub-processor is assessed for security posture (SOC 2 / ISO 27001 / DPA) before onboarding and reviewed at least annually.
- Data sharing with sub-processors is limited to what is necessary and governed by a Data Processing Agreement (and BAA where applicable).
- Customers are notified of material changes to sub-processors per contractual terms.

## 14. Incident Response

- A documented Incident Response Plan defines detection, triage, containment, eradication, recovery, and post-incident review.
- **Reporting:** Any suspected incident must be reported to the Security Officer immediately (target: within 1 hour of discovery) via _[security@ironbooks.com / defined channel]_.
- **Severity & timelines:** Incidents are triaged by severity; containment begins immediately for high-severity events.
- **Customer/partner/regulator notification** follows contractual and legal obligations (e.g. notify affected customers without undue delay, typically within 72 hours of confirming a breach of their data).
- Every incident receives a written post-mortem with root cause and corrective actions tracked to completion.

## 15. Business Continuity, Backup & Disaster Recovery

- Production databases are backed up automatically with point-in-time recovery; backups are encrypted and access-controlled.
- Backup restoration is tested periodically (at least annually).
- Recovery objectives are defined: **RPO ≤ 24h, RTO ≤ 24h** _(adjust to commitments)_.
- Critical configuration and infrastructure-as-code are version-controlled to enable rebuild.

## 16. Data Retention & Disposal

- Customer data is retained for the life of the customer relationship and a defined period thereafter, then securely deleted.
- Upon customer request or contract termination, customer data is deleted or returned within the contractual window.
- OAuth/financial-provider connections are revoked when a customer disconnects or offboards.
- Decommissioned media/storage is securely wiped or cryptographically erased (inherited from cloud providers).

## 17. Endpoint & Device Security

- Workforce devices accessing Company or customer data must use full-disk encryption, automatic screen lock, a supported/patched OS, and reputable endpoint protection.
- Production secrets and customer data are not stored on local devices.
- Lost/stolen devices are reported immediately and access revoked.

## 18. Personnel Security & Awareness

- Workforce Members agree to confidentiality obligations and this policy as a condition of access.
- Background checks are performed where legally permitted and appropriate to the role.
- Security awareness training is completed at onboarding and at least annually (phishing, credential hygiene, data handling, incident reporting).

## 19. Acceptable Use

- Company systems and data are used only for legitimate business purposes.
- No sharing of customer data outside approved systems; no use of customer data in unapproved third-party or AI tools.
- No circumventing security controls; report weaknesses rather than exploit them.

## 20. Privacy & Compliance

- The Company processes personal and financial data in accordance with applicable privacy laws (e.g. PIPEDA, U.S. state privacy laws) and its Privacy Policy.
- **Payment-card scope is minimized:** card data is handled by a PCI-DSS-compliant processor; the Company does not store full card numbers (SAQ-A posture).
- Financial-data-provider integrations (e.g. QuickBooks, Plaid) are used in accordance with their developer/security requirements.

## 21. Governance, Exceptions & Enforcement

- This policy is reviewed and approved at least annually by the Security Officer.
- **Exceptions** must be requested in writing, risk-assessed, time-bound, and approved by the Security Officer; tracked in the risk register.
- **Violations** may result in revoked access and disciplinary or contractual action.

---

## Appendix A — Sub-processor Register _(maintain current)_

| Sub-processor | Purpose | Data shared | Security basis |
|---|---|---|---|
| Cloud application host | App hosting / compute | Confidential (in transit/processing) | SOC 2 |
| Managed Postgres / Auth | Primary datastore + authentication | Restricted + Confidential | SOC 2 |
| Payment processor | Subscription billing | Billing PII, card tokens | PCI-DSS L1 |
| Financial-data provider | Bank/accounting connectivity | OAuth tokens, financial data | SOC 2 |
| CRM | Sales/onboarding | Lead/contact PII | _assess_ |
| Email delivery | Transactional email | Contact email, message content | _assess_ |
| AI provider | Categorization / summaries | Transaction metadata (no secrets) | _assess; confirm no-training_ |

## Appendix B — Related Documents
Incident Response Plan · Acceptable Use Standard · Data Retention Schedule · Risk Register · Vendor Review Log · Business Continuity / DR Plan · Privacy Policy.
