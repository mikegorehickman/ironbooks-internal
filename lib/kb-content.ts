/**
 * Ironbooks Client Knowledge Base — the FAQ content that powers
 * /portal/knowledge-base (accordion) and /api/portal/kb-search (AI answers
 * grounded in exactly this text).
 *
 * Answers are markdown-lite: **bold**, "- " bullets, "1." numbered lists,
 * blank-line paragraphs. Rendered by the portal's MdLite component and fed
 * verbatim to the AI as its only source of truth.
 */

export interface KBItem {
  id: string;
  question: string;
  answer: string;
}

export interface KBCategory {
  id: string;
  title: string;
  items: KBItem[];
}

export const KB_CATEGORIES: KBCategory[] = [
  {
    id: "quickbooks-bank-feeds",
    title: "QuickBooks & Bank Feeds",
    items: [
      {
        id: "bank-feed-disconnected",
        question: "My bank feed disconnected in QuickBooks. What do I do?",
        answer: `Bank feeds disconnect all the time — it's one of the most common issues we see. It usually happens when you change your bank password, your bank updates its security settings, or too much time passes without a login.

To fix it: Go into QuickBooks Online → Banking → find the disconnected account → click "Reconnect" or "Fix connection." QuickBooks will walk you through re-authenticating with your bank. You may need to go through two-factor authentication on your phone.

When reconnecting, you'll be asked for a start date for transaction downloads. Use the date after your last reconciled statement. Don't pull in more history than you need — it creates more cleanup.

If you can't get it to reconnect, upload your bank statements as a CSV file instead, or drop the PDF statements in the portal. We can work with that.`,
      },
      {
        id: "qb-balance-mismatch",
        question: "My QuickBooks balance doesn't match what's in my actual bank account. Why?",
        answer: `This almost always means the account hasn't been properly reconciled. Reconciling means confirming that every transaction in QuickBooks matches your actual bank statement — dollar for dollar.

Common reasons for a mismatch:
- Transactions were deleted or edited after a previous reconciliation
- Old, uncleared transactions are sitting there from months or years ago
- There are duplicate transactions from an app integration
- The opening balance was entered incorrectly when the account was first set up

Your balance sheet should always reflect your real bank balance. If it doesn't, the financial statements you're reading aren't accurate — which means any decisions you make from them could be off. This is something we'll clean up during your reconciliation.`,
      },
      {
        id: "uncategorized-backlog",
        question: "There are thousands of uncategorized transactions in QuickBooks. Do I need to go through all of them?",
        answer: `No — that's our job. When we take on a new client, we work through the backlog systematically. We create bank rules to automatically categorize recurring vendors (like Sherwin-Williams, Home Depot, Gusto payroll, etc.), which handles the bulk of it fast.

For anything we genuinely can't identify, we'll send you a question through the portal. Each one will show you the transaction — you just need to type a short description. Things like "paint supplies for the Adams job" or "gas for the work truck" is enough. You don't need to be detailed unless it was something unusual like a large equipment purchase, a loan payment, or a personal expense that came through the business account.`,
      },
      {
        id: "messy-quickbooks",
        question: "Someone else set up my QuickBooks and it's a mess. Can you fix it?",
        answer: `Yes, this is the most common situation we walk into. Whether it was a previous bookkeeper, a family member, or you doing your best on your own — messy books are fixable.

The cleanup process involves: reconciling all bank and credit card accounts, fixing the chart of accounts so expenses are categorized correctly, resolving balance sheet issues (undeposited funds, old outstanding transactions, etc.), and making sure payroll flows into the right place.

Depending on how far back the issues go, cleanup can take anywhere from a few days to a few weeks. We'll assess when we get in and give you a clear picture of what needs to happen.`,
      },
      {
        id: "desktop-to-online",
        question: "Should I switch from QuickBooks Desktop to QuickBooks Online?",
        answer: `Yes. QuickBooks Desktop is being phased out and doesn't support the bank feeds, app integrations, and remote access that Online does. We work exclusively in QuickBooks Online.

The migration process involves exporting your Desktop data and importing it into a new Online company file. There can be some quirks in the migration — especially around balance sheet accounts and historical data — and we'll review everything after the move to make sure it came over cleanly.`,
      },
    ],
  },
  {
    id: "app-integrations",
    title: "App Integrations (DripJobs, Jobber, Stripe)",
    items: [
      {
        id: "dripjobs-duplicate-revenue",
        question: "DripJobs (or Jobber) is sending invoices into QuickBooks and now I have duplicate revenue. What's going on?",
        answer: `This is one of the most common problems we see with painting businesses. When DripJobs or Jobber is connected to QuickBooks, it pushes invoices over every time a job is marked complete. If your bank feed is also pulling in deposits from those same jobs, you can end up counting the same revenue twice.

The result: your sales look higher than they actually are, your tax bill could be wrong, and your reports are unreliable.

**The fix depends on how you want to handle it:**

Option A — Disconnect the integration and enter payments directly in QuickBooks. Cleaner, simpler, but requires a process change.

Option B — Keep the integration but reconcile deposits against the invoices each month (instead of relying on bank deposits as additional income). This requires more ongoing work but keeps your job-level data inside your CRM.

We'll evaluate which option makes more sense for your business and handle the reconciliation. Until it's sorted, don't assume your revenue numbers are accurate.`,
      },
      {
        id: "disconnect-crm",
        question: "Should I disconnect DripJobs or Jobber from QuickBooks?",
        answer: `For most painting businesses, the answer is yes — at least temporarily. The integrations are rarely configured correctly out of the box, and the duplicate revenue problem causes more harm than the integration provides benefit.

Your CRM (DripJobs, Jobber, etc.) is where you manage jobs and estimates. QuickBooks is where the money lives. They don't need to talk directly to each other if the connection is causing problems.

If you want to keep job-level data in QuickBooks for true job costing, we can discuss a cleaner way to do it — like a monthly upload from a spreadsheet rather than a live sync.`,
      },
      {
        id: "stripe-double-counting",
        question: "Stripe is showing up as income in QuickBooks but I'm also recording invoices. Am I double-counting revenue?",
        answer: `Probably. This is the same issue as the DripJobs problem above. If Stripe is connected to QuickBooks AND you're recording invoices separately, you're likely double-counting.

The correct approach: Record the invoice when the job is done (this is your revenue). When the Stripe payment comes in, match it against that open invoice — don't record it as separate income. If you're on a cash basis, just record the deposit and make sure it matches a specific job.

We'll sort through your Stripe history and get it reconciled properly.`,
      },
      {
        id: "paintscout-labor-data",
        question: "PaintScout / Jobber isn't giving me accurate job cost or labor data. What should I do?",
        answer: `This is a known limitation. Most estimating and job management apps track estimates and invoices well, but labor cost data — especially piece-rate or hour-by-hour labor — is unreliable unless it's set up carefully.

For job costing purposes, your best source of truth is usually your payroll system (Gusto, ADP, etc.) for labor, and your actual receipts for materials. We can help you build a simple monthly process to capture this accurately — it doesn't require your CRM to do the heavy lifting.`,
      },
    ],
  },
  {
    id: "financial-reports",
    title: "My Financial Reports",
    items: [
      {
        id: "draft-vs-verified",
        question: "My statements say DRAFT — what's the difference between draft and verified?",
        answer: `For your first month or two with us, your statements go out marked **DRAFT**. That's on purpose.

A draft is our best picture of your business from the information we have so far — but **you know your business best**. Before we call your books verified, we need you to gut-check a few things right in your portal:
- Is all of your **revenue** showing?
- Are **all** your bank accounts, credit cards, and loans included?
- Have you paid anyone in **cash** that isn't reflected?
- Does the **sales tax** look right?

Answer those questions on the draft statement page (takes about 2 minutes), and either approve it or tell us what's missing. Once you've confirmed everything and our senior team signs off, your books graduate to **verified** — and every statement after that goes out without the DRAFT label.

If you never respond, your statements simply stay marked DRAFT — so if you're seeing that label after a few months, the fastest fix is to complete the quick review in your portal.`,
      },
      {
        id: "when-statements",
        question: "When do I get my financial statements each month?",
        answer: `Your financial statement package — P&L, balance sheet, and cash flow statement — is published in your portal by the **24th of each month**, covering the prior month.

So if it's June, you'll get your May statements by June 24th.`,
      },
      {
        id: "upload-by-10th",
        question: "What do I need to upload by the 10th, and why does it matter?",
        answer: `By the **10th of each month**, upload the following to your portal:
- Bank statements (all business accounts)
- Credit card statements (all business cards)
- Loan statements (if applicable)

We need these to reconcile your accounts and confirm every transaction is captured — even if your bank feed is connected. Bank feeds sometimes miss transactions or show pending items. The statement is the official record.

If you get your statements later in the month (some banks take longer), just get them to us as soon as you have them and let us know. Missing the deadline by a few days isn't a crisis, but the earlier we get them, the easier it is to hit the 24th turnaround.`,
      },
      {
        id: "pl-looks-different",
        question: "Why does my P&L look completely different from what I thought I was making?",
        answer: `A few common reasons:

1. **Things are in the wrong category.** If your painter wages are sitting in "operating expenses" instead of Cost of Goods Sold, your gross profit looks artificially high — and then your overhead looks way too big. The gross profit number becomes meaningless.

2. **Revenue is overstated.** Duplicate invoices from app integrations or unmatched deposits recorded as income inflate your top line.

3. **Personal expenses are mixed in.** If you're running personal purchases through the business account, they show up as business expenses and drag down your profit.

4. **Owner draws are recorded wrong.** Some clients record owner draws as an expense, which shows a loss that isn't really there.

Once we clean up the chart of accounts and reconcile properly, the numbers tell a much more accurate story — which might be better or worse than what you thought, but at least it's real.`,
      },
      {
        id: "reconciled-but-wrong",
        question: "My bookkeeper said everything was reconciled, but the numbers still don't look right. Is that possible?",
        answer: `Yes. "Reconciled" means the bank balance in QuickBooks matches the bank statement. It doesn't mean the transactions are categorized correctly, or that the balance sheet is clean, or that there aren't duplicate entries.

We often see books that are technically reconciled but full of miscategorized transactions, old uncleared items that were never resolved, balance sheet entries that don't make sense, and integrations causing phantom revenue. Reconciliation is step one — but it's not the whole picture.`,
      },
      {
        id: "reading-statements",
        question: "What's a financial statement package and how do I read it?",
        answer: `Your package includes three reports:

**Profit & Loss (P&L):** Shows your revenue, cost of goods sold, and expenses for the month. The bottom line tells you whether you made money. This is the report you'll look at most.

**Balance Sheet:** A snapshot of what your business owns (assets like cash, equipment, money owed to you) and what it owes (loans, credit cards, payroll liabilities). Think of it as the health of your business on a specific date.

**Cash Flow Statement:** Shows where money actually came in and went out. This is different from the P&L because it includes loan payments, owner draws, and other non-expense cash movements.

We offer financial literacy classes that walk through all three in plain language. If you're not sure how to read your reports, sign up — it's included in your plan.`,
      },
    ],
  },
  {
    id: "cogs-coa",
    title: "Cost of Goods Sold & Chart of Accounts",
    items: [
      {
        id: "cogs-vs-expenses",
        question: "What's the difference between Cost of Goods Sold (COGS) and regular expenses?",
        answer: `**Cost of Goods Sold (COGS)** = the direct costs of doing the work. For a painting business, that means:
- Painter wages and subcontractor payments
- Payroll taxes for field labor
- Paint, primer, brushes, tape, and other job supplies
- Equipment rental for specific jobs

**Operating expenses (overhead)** = the costs of running the business that aren't tied to a specific job:
- Office rent and utilities
- Insurance (general liability, vehicle, health)
- Marketing and advertising
- Software subscriptions (CompanyCam, DripJobs, etc.)
- Admin wages
- Vehicle costs (if not job-specific)
- Owner salary (in an S-corp structure)

Why does it matter? Because gross profit = revenue minus COGS. If your painter wages are sitting in overhead instead of COGS, your gross profit looks great on paper — but it's a lie. You can't accurately assess job profitability or compare your numbers to industry benchmarks if things are in the wrong place.`,
      },
      {
        id: "wages-in-expenses",
        question: "My painter wages are showing up as regular expenses, not COGS. Does that matter?",
        answer: `Yes, this matters a lot. Painter wages should be in Cost of Goods Sold because they're a direct cost of completing jobs. When they're in operating expenses instead, your gross profit is overstated and your net income is understated — both in misleading ways.

We fix this during the chart of accounts cleanup. Going forward, your payroll system (Gusto, ADP, etc.) will export wages that we categorize into COGS for field labor and overhead for office/admin staff.`,
      },
      {
        id: "subcontractors-category",
        question: "What about subcontractors? Where do they go?",
        answer: `Subcontractor payments go in Cost of Goods Sold — same as employee labor. They're a direct cost of producing revenue.

Make sure you're issuing 1099s at year-end for any subcontractor you paid $600 or more during the year. Your CPA or we can help with that.

One important note: there's a real legal distinction between a subcontractor and an employee. If you're directing when and how someone works, providing their tools, and they work exclusively for you — the IRS (or CRA) may consider them an employee regardless of what you call them. Misclassifying employees as subcontractors is a common audit trigger. When in doubt, talk to your CPA.`,
      },
      {
        id: "gross-profit-swings",
        question: "Why does my gross profit percentage keep changing month to month?",
        answer: `Normal fluctuation exists — seasonal jobs, one-off material costs, slow months. But big swings usually mean one of the following:

1. Payroll was posted inconsistently (some months in COGS, some in overhead)
2. A large supply purchase or subcontractor payment was miscategorized
3. Revenue was duplicated one month from an integration issue
4. Owner draws are being recorded as expenses in some months but not others

A stable gross profit % tells you your pricing and labor efficiency are consistent. Wild swings usually mean a bookkeeping issue, not a business problem. We'll flag these for you each month.`,
      },
    ],
  },
  {
    id: "payroll-classification",
    title: "Payroll & Worker Classification",
    items: [
      {
        id: "w2-vs-1099",
        question: "Should I pay my painters as employees (W-2) or subcontractors (1099)?",
        answer: `This is one of the most common and highest-stakes questions we get. Here's the honest answer:

**If you're directing their work — telling them when to show up, what to paint, how to do it, and they're working exclusively for you — they should probably be W-2 employees.** The IRS and CRA have specific rules for worker classification, and the label you use doesn't override the actual working relationship.

**Subcontractors** work on their own schedule, bring their own tools, set their own rates, and work for multiple clients. A true subcontractor is usually a small painting company you hire for overflow, not one of your regular crew members.

Why does this matter? Misclassifying employees as subcontractors means you're not withholding income taxes, not paying payroll taxes, and potentially exposing yourself to significant back taxes, penalties, and interest if audited. We've seen clients face large CRA and IRS assessments because of this.

The tradeoff is real: employees cost more (payroll taxes, workers' comp, etc.) but they're the right structure if that's the relationship. Talk to your CPA about the specifics for your situation.`,
      },
      {
        id: "payroll-setup",
        question: "How do I set up payroll?",
        answer: `We work primarily with **Gusto** for US clients. It's the simplest, most reliable option for small painting businesses and integrates cleanly with QuickBooks.

To get set up, you'll need:
- Your EIN (Employer Identification Number)
- State employer registration (varies by state)
- Employee information: legal name, address, SSN, W-4 on file
- Voided check or bank letter for direct deposit
- Workers' comp information if required in your state

First payroll typically takes about a week to set up properly for direct deposit. If you have a payday coming sooner, we can issue manual checks as a stopgap.

For **Canadian clients**, we work with a few payroll providers and can also run payroll directly through QuickBooks Payroll or help set up Payworks, ADP, or another platform you prefer.`,
      },
      {
        id: "payroll-sync-issues",
        question: "My payroll provider isn't syncing correctly with QuickBooks. What do I do?",
        answer: `Don't try to fix it by editing transactions directly in QuickBooks — that usually makes it worse. The fix depends on the platform:

- **Gusto:** Export the payroll summary and post a journal entry in QuickBooks that matches the Gusto numbers exactly — gross wages to COGS/overhead, payroll taxes, and net pay.
- **ADP/Paychex:** Similar approach — use their payroll register report to create a matching journal entry.

The key is that your QuickBooks payroll entries should match your actual payroll register dollar for dollar. If they don't, your P&L labor numbers are unreliable and your payroll tax liabilities on the balance sheet will be wrong.

We handle this reconciliation as part of your month-end process.`,
      },
      {
        id: "under-the-table",
        question: "I paid someone under the table. Does that need to be in my books?",
        answer: `Yes — it still needs to be recorded as an expense, even if taxes weren't withheld. Cash or under-the-table payments that aren't recorded cause your expenses to be understated, making your profit look higher (and your tax bill larger) than it actually is.

More importantly, paying employees without withholding taxes and without issuing W-2s or 1099s is a legal problem. If someone you paid under the table gets injured or files for unemployment, you're exposed. The IRS and CRA take this seriously.

Talk to your CPA about how to handle it going forward. It's fixable, but it needs to be addressed properly.`,
      },
    ],
  },
  {
    id: "owner-pay",
    title: "Owner Pay & Draws",
    items: [
      {
        id: "draw-vs-salary",
        question: "What's the difference between an owner's draw and a salary?",
        answer: `**Owner's draw:** You transfer money from the business account to your personal account. In QuickBooks, this gets recorded as a draw (or distribution) on your balance sheet — it's NOT an expense and doesn't reduce your taxable income. For LLCs and sole proprietors, this is how you typically pay yourself.

**Owner's salary:** You run yourself through payroll, withhold taxes, and pay yourself like any other employee. This is required if you have an S-corp election, where the IRS expects you to pay yourself a "reasonable salary." The salary IS an expense and DOES reduce taxable income — but you're also paying employer payroll taxes on it.`,
      },
      {
        id: "how-much-pay-myself",
        question: "How much should I pay myself?",
        answer: `This is more of a financial coaching question than a bookkeeping one, but here's a framework Lisa uses frequently:

Start with your target net profit %. Once you know what the business should be clearing, build in your salary or draw as a consistent line item — not just "whatever's left in the account." A lot of owners underpay themselves for years, then overdraw when things get tight, which messes up both cash flow and the books.

If you're an S-corp, the IRS requires a "reasonable salary" — roughly what you'd pay someone else to do your job. Under-paying yourself to avoid payroll taxes is an audit risk.

For specific numbers, work through this with Kedma in a financial coaching session.`,
      },
      {
        id: "draws-as-expense",
        question: "I've been recording my owner draws as an expense. Is that a problem?",
        answer: `Yes. Owner draws should go to the equity section of your balance sheet (as "owner draws" or "distributions"), not as an expense on your P&L.

When draws are recorded as expenses, your net income looks lower than it actually is — sometimes to the point where the business appears to be losing money when it's actually profitable. This gives you and your CPA a completely wrong picture.

We'll fix the categorization during cleanup.`,
      },
      {
        id: "partner-draws",
        question: "My partner and I both take money from the business. How should that be tracked?",
        answer: `Each owner should have a separate draw/distribution account on the balance sheet. This keeps things clean for tax purposes and makes it easy to see what each owner has taken versus their ownership percentage.

If you're an LLC, distributions don't have to be proportional to ownership — but your operating agreement should cover this. If you're an S-corp, distributions should generally be proportional. Talk to your CPA.`,
      },
    ],
  },
  {
    id: "tax-planning-us",
    title: "Tax Planning (US)",
    items: [
      {
        id: "tax-set-aside",
        question: "How much should I set aside for taxes?",
        answer: `A general rule Lisa uses: **set aside 25–30% of net profit for federal and state taxes** if you're a sole proprietor or LLC filing as a pass-through. If you're an S-corp paying yourself a salary, you're already withholding taxes on that portion — so you mainly need to cover the remaining business profit.

The safest way to do this is to open a separate savings account and move money into it every time you get paid. Don't wait until Q4 to figure out what you owe.

Estimated quarterly tax payments are due: April 15, June 15, September 15, and January 15. Missing them results in underpayment penalties. Talk to your CPA about the right estimated payment amounts for your situation.`,
      },
      {
        id: "s-corp-election",
        question: "What is an S-corp and should I elect it?",
        answer: `An S-corp is a tax classification (not a business structure). An LLC can elect to be taxed as an S-corp. The benefit: you pay yourself a reasonable salary, and any additional profit you take as a distribution isn't subject to self-employment tax (15.3% on the first ~$160K). At higher income levels, this saves real money.

The downside: more compliance requirements — payroll, payroll taxes, quarterly reports. It only makes financial sense once your net profit consistently exceeds roughly $50–75K, though the threshold depends on your state and situation.

This is a CPA decision, not a bookkeeping one. We can provide you the clean financial data your CPA needs to model it out. Don't make this decision without talking to a CPA first.`,
      },
      {
        id: "vehicle-deduction",
        question: "Can I deduct my vehicle?",
        answer: `Yes, with the right documentation. Two main options:

1. **Standard mileage rate:** Track business miles and multiply by the IRS rate (67 cents/mile in 2024). Simple, no depreciation schedule needed.
2. **Actual expenses:** Deduct the business-use percentage of gas, insurance, repairs, depreciation, and loan interest. More work, potentially higher deduction.

If you financed or purchased a vehicle for the business in 2025, ask your CPA about **Section 179 or bonus depreciation** — you may be able to deduct the full cost in year one rather than depreciating over several years. This is worth a conversation.

Keep a mileage log or use an app. The IRS requires documentation of business purpose for vehicle deductions.`,
      },
      {
        id: "home-office",
        question: "Can I deduct my home office?",
        answer: `Yes, if you have a space used regularly and exclusively for business. Two methods:

1. **Simplified:** $5/sq ft, up to 300 sq ft ($1,500 max). Easy, no depreciation.
2. **Regular method:** Deduct the business-use percentage of rent/mortgage interest, utilities, and insurance. Higher deduction usually, but triggers depreciation recapture if you sell.

For most small painting businesses without a dedicated office space, the simplified method is fine. Talk to your CPA.`,
      },
      {
        id: "unfiled-taxes",
        question: "My taxes haven't been filed for a year or two. What do I do?",
        answer: `Don't ignore it — the penalties and interest compound over time, and the IRS/CRA tends to find it eventually. Filing late is much better than not filing.

Immediate steps:
1. Don't panic — this is fixable
2. Get your books cleaned up (we handle this)
3. Work with a CPA to file the back returns
4. If you owe, explore payment plans — the IRS has installment agreement programs; CRA has voluntary disclosure

We've worked with many clients in this situation. The goal is to get caught up with accurate books, minimize penalties where possible, and build a clean process going forward.`,
      },
    ],
  },
  {
    id: "hst-gst-canada",
    title: "HST/GST & CRA (Canada)",
    items: [
      {
        id: "hst-registration",
        question: "When do I need to register for HST/GST?",
        answer: `In Canada, you must register for HST/GST once your business revenue exceeds **$30,000 in a 12-month period**. Once you hit that threshold, you must register and start collecting HST/GST on taxable sales.

If you're below $30K, registration is optional (but you can't claim input tax credits until you're registered).

Most painting businesses we work with are well above the $30,000 threshold and should already be registered. If you're not sure whether you're registered, check your CRA My Business Account.`,
      },
      {
        id: "input-tax-credit",
        question: "What is an Input Tax Credit (ITC)?",
        answer: `An ITC is the HST you paid on business expenses that you get to deduct from the HST you collected. So if you charged $1,300 in HST to clients and paid $300 in HST on supplies and business expenses, you only remit $1,000 to CRA.

The catch: you need receipts to support your ITC claims. Keep all your business receipts. For large purchases, make sure the supplier's HST number is on the invoice.`,
      },
      {
        id: "hst-filing-frequency",
        question: "How often do I need to file HST?",
        answer: `Filing frequency depends on your revenue:
- **Annual:** Under $1.5M in revenue (with quarterly installments if you owe more than $3,000/year)
- **Quarterly:** $1.5M–$6M
- **Monthly:** Over $6M

Most painting businesses are on annual or quarterly filing. CRA assigns your filing frequency when you register, but you can request to file more often if you prefer.

Check your CRA account if you're not sure what your assigned frequency is.`,
      },
      {
        id: "cra-collections",
        question: "I got a collections notice from CRA. What should I do?",
        answer: `**Don't ignore it.** CRA collections notices are serious and have hard deadlines. Here's what to do immediately:

1. Log into your CRA My Business Account and confirm the amount and what it's for
2. Gather supporting documents (payroll remittance records, HST returns, assessment notices)
3. Contact us immediately so we can review the situation

If the amount is correct and you owe it, CRA offers payment arrangements — you don't have to pay it all at once. If the amount is wrong (we see this with incorrect assessments or duplicate entries), we can help you dispute it.

Ignoring a collections notice can result in CRA garnishing your bank account or contacting your customers directly. Don't let it get there.`,
      },
      {
        id: "voluntary-disclosure",
        question: "What is a voluntary disclosure and should I do one?",
        answer: `CRA's Voluntary Disclosure Program (VDP) lets you come forward to correct errors or omissions in past returns — like unfiled HST, underreported income, or missing payroll remittances — in exchange for reduced penalties and partial interest relief.

The key requirement: you must come forward **before CRA contacts you** about the issue. Once they've started an audit or sent you a letter about a specific problem, you can no longer use VDP for that issue.

If you know you have past filing problems and CRA hasn't contacted you yet, it's worth discussing VDP with us and your CPA. In some cases, it can significantly reduce what you owe.`,
      },
      {
        id: "hst-revenue-mismatch",
        question: "My HST and my QuickBooks revenue numbers don't match. Why?",
        answer: `This is common and usually comes down to one of these:
- **Cash vs. accrual mismatch:** HST is typically reported on the accrual basis (when invoiced), while QuickBooks may be set to cash basis (when paid). If you have outstanding invoices, the numbers will differ.
- **Input tax credits not fully claimed:** Your bookkeeper may have missed some business expenses that included HST.
- **Deposits or retainers:** If you collect HST on deposits but don't record them in QuickBooks until the job is complete, there's a timing mismatch.
- **Personal transactions:** Non-business HST shouldn't be included in your ITCs.

We reconcile your HST account each month as part of the month-end process to catch these issues before they become a CRA problem.`,
      },
    ],
  },
  {
    id: "job-costing",
    title: "Job Costing & Gross Profit",
    items: [
      {
        id: "gross-profit-target",
        question: "What gross profit percentage should I be targeting?",
        answer: `For painting businesses, a **healthy gross profit range is 40–55%**. Here's how it breaks down:

- **Gross profit under 30%:** You're pricing too low, labor costs are out of control, or COGS is miscategorized. Something's wrong.
- **30–40%:** Tight. You don't have much room for overhead or profit.
- **40–55%:** Healthy range. You can cover overhead and still make money.
- **Above 55%:** Either pricing is excellent, you're using very efficient subcontractor models, or COGS might be miscategorized.

**Important:** These numbers only mean something if your wages and subcontractor costs are actually in COGS. If they're sitting in overhead, your gross profit will look artificially high.`,
      },
      {
        id: "magic-number",
        question: 'What is the "magic number" I keep hearing about?',
        answer: `The "magic number" refers to your **overhead expense ratio** — what percentage of revenue goes to running the business (not including COGS). It tells you how much of every dollar is consumed by overhead before you make a profit.

The formula: Total overhead expenses ÷ Total revenue = your magic number (expressed as a %)

If your magic number is 35%, that means 35% of every dollar goes to overhead. Combined with a 45% gross profit, that leaves 10% net profit.

The goal: keep overhead lean so more of your gross profit flows to the bottom line. Common overhead items that can be reduced: admin wages, duplicate software subscriptions, marketing that isn't producing jobs.`,
      },
      {
        id: "job-profitability",
        question: "How do I know if a specific job made money?",
        answer: `True job costing requires tracking revenue and direct costs per job. Most painting businesses aren't doing this in QuickBooks — they're tracking it in DripJobs, Jobber, or spreadsheets, which is fine.

At minimum, for each job you should know:
- What you charged (contract amount)
- What you paid in labor for that job
- What you spent on materials

Labor ÷ Job revenue = labor cost ratio. Paint and materials ÷ Job revenue = materials cost ratio. These two combined should stay within your COGS target.

If you're using a production tracking app or have crew hour data, Lisa can help you build a simple job costing process into your monthly workflow.`,
      },
    ],
  },
  {
    id: "balance-sheet",
    title: "Balance Sheet Questions",
    items: [
      {
        id: "undeposited-funds",
        question: 'What are "Undeposited Funds" in QuickBooks?',
        answer: `Undeposited Funds is a holding account in QuickBooks for money you've received but haven't officially "deposited" yet by matching it to a bank deposit. Think of it like the tray where you put checks before taking them to the bank.

When it's used correctly, the Undeposited Funds balance should be close to zero — money moves through it and gets cleared quickly. When it has a large balance, it usually means payments were received in QuickBooks but never matched to an actual bank deposit. This overstates your cash position.

We clear Undeposited Funds during the reconciliation process.`,
      },
      {
        id: "accounts-receivable",
        question: "What is Accounts Receivable (A/R)?",
        answer: `Accounts Receivable is money your clients owe you — jobs that are invoiced but not yet paid. A healthy A/R number means you're billing promptly and clients are paying. A large, growing A/R means money is stuck in unpaid invoices.

If your A/R has invoices that are 90+ days old, they may need to be written off as bad debt. This is a tax deduction but also a signal to tighten up your collection process.

We'll review your A/R each month and flag anything that looks overdue or incorrect.`,
      },
      {
        id: "shareholder-loan",
        question: "What is a Shareholder Loan (Canada)?",
        answer: `A shareholder loan is money that moves between you (as owner) and your corporation. It can go either direction:

- **Company owes you money** (you loaned the company money): This is a liability on the balance sheet — the company owes you back.
- **You owe the company money** (you took more money out than you put in): This is an asset on the balance sheet — a receivable the company has from you. If this balance isn't cleared within a year, CRA requires you to include it as taxable income.

This is an area where incorrect QuickBooks entries cause big problems. If your shareholder loan is in the wrong place, it can distort your entire balance sheet and create unexpected tax exposure. We monitor this carefully.`,
      },
      {
        id: "old-balance-sheet-items",
        question: "My balance sheet has a bunch of old transactions from years ago. Do we need to clean those up?",
        answer: `Usually yes, but it depends on what they are.

Old uncleared bank transactions, phantom accounts receivable from years ago, loans that were paid off but are still showing a balance — all of these make your balance sheet unreliable and confuse anyone looking at your financials (banks, CPAs, potential buyers).

The cleanup process for old balance sheet items typically involves journal entries to write off or reclassify items. We handle this in coordination with your CPA for anything that has tax implications.`,
      },
    ],
  },
  {
    id: "financing-cash-flow",
    title: "Financing & Cash Flow",
    items: [
      {
        id: "merchant-cash-advance",
        question: "I'm thinking about taking a merchant cash advance (MCA). Should I do it?",
        answer: `We see a lot of clients dealing with the fallout from MCAs, so we approach this cautiously.

MCAs provide fast cash but at very high effective interest rates — often 40–80% APR when you factor in the full cost. The daily/weekly repayment structure can also create serious cash flow pressure because the payments keep coming whether business is good or not.

They're not always the wrong call — if you have a specific, high-margin job lined up and need bridge capital to fund materials, it can work. But as a general cash flow solution, MCAs tend to make financial problems worse over time.

Before going that route, talk to Kedma about alternatives: supplier credit, a bank line of credit, or restructuring your deposit policy to collect more upfront from customers.`,
      },
      {
        id: "cash-reserve",
        question: "How do I set up a cash reserve for slow seasons?",
        answer: `The simplest method: open a separate business savings account and automate a transfer of a set dollar amount or percentage of revenue every week or month. Treat it like a bill you have to pay.

A good starting target: 3 months of fixed overhead expenses. So if your office rent, insurance, software, and admin wages total $8,000/month, aim for a $24,000 reserve.

Profit First is a popular framework for this — Lisa's view is that it can be helpful when starting out but becomes cumbersome as you grow, mostly because of the multiple bank accounts. The concept (allocate money to buckets before you spend it) is sound regardless of how you implement it.`,
      },
      {
        id: "finance-or-cash-vehicle",
        question: "I want to buy another truck/van for the business. Should I finance it or pay cash?",
        answer: `This is a Virtual CFO question — the right answer depends on your cash position, interest rates, the cost of the vehicle, and your revenue growth plans.

A few things we look at: Can the business cash flow the payment without stress? What's the interest rate? Does it make more sense to preserve cash (for slow season, emergencies, or growth) and finance at a low rate? Or is debt already a concern and paying cash reduces your risk exposure?

Bring this to a financial coaching session with Kedma. We'll model it out with your actual numbers.`,
      },
    ],
  },
  {
    id: "business-structure",
    title: "Business Structure",
    items: [
      {
        id: "incorporate",
        question: "I'm a sole proprietor. Should I incorporate?",
        answer: `This is a tax and legal question that depends on your revenue, province/state, personal income, and risk tolerance. General guidance:

**In Canada:** Incorporating makes sense once you're consistently profitable at roughly $100K+ net and want to leave money in the company at the lower corporate tax rate. It also provides liability protection. The downside: more compliance (annual corporate return, HST remittances, payroll for yourself, etc.).

**In the US:** Forming an LLC provides liability protection without much additional complexity. The S-corp election (see Tax Planning section) makes sense at higher income levels.

You should make this decision with your CPA, not your bookkeeper. We can provide clean financial statements that help the CPA give you a proper recommendation.`,
      },
      {
        id: "multiple-businesses",
        question: "I have multiple businesses. Can you handle all of them?",
        answer: `Yes — several of our clients have multiple entities. The key things we need:

1. Each entity needs its own QuickBooks file and its own bank accounts. Commingling money between entities creates serious accounting, tax, and legal problems.
2. If entities share expenses (like a shared office or staff), there needs to be an intercompany allocation process — we'll set this up.
3. Each entity will be treated as a separate engagement with its own monthly deliverables.`,
      },
      {
        id: "selling-business",
        question: "I'm thinking about selling my business someday. How does that affect my bookkeeping?",
        answer: `Buyers and their accountants look at 2–3 years of clean financials when evaluating a business. Messy books, inconsistent categorization, and mixed personal/business expenses lower your business value and make deals harder to close.

If you have any thought of selling in the next few years, now is the time to get the books clean and keep them that way. Accurate gross profit margins, clearly categorized overhead, and a well-organized balance sheet add demonstrable value to a business.`,
      },
    ],
  },
  {
    id: "working-with-ironbooks",
    title: "Working With IronBooks",
    items: [
      {
        id: "transaction-question",
        question: "I have a question about a specific transaction. How do I ask?",
        answer: `Use the portal. Go to your portal, click on "Transaction Questions," and enter your question. Attach screenshots or documents if helpful. We're notified right away and typically respond within 1–2 business days.

For urgent questions (something time-sensitive with CRA, a bank, a vendor, etc.), email or call Lisa directly. Contact info is in your welcome email.`,
      },
      {
        id: "strategic-questions",
        question: "I have a strategic financial question (not a bookkeeping question). Who do I talk to?",
        answer: `Kedma handles financial coaching and strategic advisory. Questions like: how much should I pay myself, should I hire an employee or subcontractor, can the business afford a new truck, what's my break-even — these go to Kedma through the group coaching calls, office hours, or her booking link.

Lisa handles the transactional bookkeeping, month-end reconciliations, QuickBooks, and anything related to your actual numbers.

Both of them talk daily, so nothing falls through the cracks.`,
      },
      {
        id: "cpa-access",
        question: "My accountant/CPA wants to see my books. How do we do that?",
        answer: `Your CPA should have access to QuickBooks Online directly — you can add them as an Accounting Firm user (same way you added IronBooks). Or they can pull reports directly from your portal.

If your CPA is preparing your annual return, let us know in advance. We'll make sure the books are clean, categorized correctly, and all year-end adjustments are flagged. Good bookkeeping on our end makes your CPA's job faster and usually cheaper.`,
      },
      {
        id: "still-need-cpa",
        question: "Do I still need a CPA if I have IronBooks?",
        answer: `Yes. IronBooks handles bookkeeping and financial coaching — we're not filing your taxes. You still need a CPA (or EA in the US) for:
- Annual tax return preparation
- S-corp election and shareholder tax decisions
- Business structure advice
- Handling IRS/CRA audits or correspondence
- Major financial decisions with tax implications

Our job is to keep your books clean and current so your CPA has accurate data to work with — which saves you money on your CPA bill and prevents surprises at tax time.`,
      },
      {
        id: "missed-uploads",
        question: "I missed uploading my statements for a couple months. What happens?",
        answer: `We can usually catch up — it just takes more time. Provide the missing statements and we'll work through the backlog. Let us know in the portal or by email so we can adjust the timeline.

If statements are more than 3–6 months late, there may be a catch-up fee depending on the volume. We'll let you know before we start.

Going forward: if you know you're going to miss the 10th, just send a quick message. No surprises is our rule — and it applies both ways.`,
      },
    ],
  },
];

/** Flattened plain-text KB used as the AI search's grounding context. */
export function kbAsPlainText(): string {
  return KB_CATEGORIES.map(
    (cat) =>
      `## ${cat.title}\n\n` +
      cat.items.map((i) => `### ${i.question}\n${i.answer}`).join("\n\n")
  ).join("\n\n");
}
