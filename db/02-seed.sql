-- Seed data: sample users + a sample month-end cycle, modeled on a typical
-- accounting month-end checklist. Names, links and account numbers below are
-- placeholders — replace with your own team and links after installing.

INSERT INTO users (name) VALUES
  ('Alex Morgan'),
  ('Jordan Lee'),
  ('Sam Rivera'),
  ('Taylor Kim'),
  ('Casey Nguyen');

INSERT INTO cycles (label, year, month, status) VALUES ('2026-06', 2026, 6, 'archived');

WITH c AS (SELECT id FROM cycles WHERE label = '2026-06'),
     u AS (SELECT id, name FROM users)
INSERT INTO tasks (
  cycle_id, sort_order, task_name, description, dependency_text, due_date,
  booking_responsible_id, quality_check_id, url, powerbi_url,
  booking_status, check_status, date_finished, comment, mg_comment
)
SELECT c.id, t.sort_order, t.task_name, t.description, t.dependency_text, t.due_date,
       ur.id, uq.id, t.url, t.powerbi_url,
       t.booking_status, t.check_status, t.date_finished, t.comment, t.mg_comment
FROM c,
LATERAL (VALUES
  (10, 'Update FX Rates', 'Update FX rates with Closing and Average rates from the central bank', NULL, '1', 'Alex Morgan', 'Jordan Lee', 'https://example.com/fx-rates-sheet', NULL, 'done', 'done', '2026-06-01'::date, NULL, NULL),
  (20, 'Update FX Rates in Fortnox', 'Settings > Supplier Invoices > Currency', 'Update FX Rates', '1', 'Alex Morgan', NULL, NULL, NULL, 'done', 'done', NULL, NULL, NULL),
  (30, 'Update rates at control flow, fx rates monthly', NULL, NULL, '1', 'Alex Morgan', NULL, NULL, 'https://example.com/powerbi/fx-control-flow', 'done', 'done', NULL, NULL, NULL),
  (40, 'Run Period Allocations', 'Fortnox > Accounting > Period Allocations. Check Report > Period Allocations against Balance Sheet', NULL, '1', 'Alex Morgan', NULL, NULL, NULL, 'done', 'done', NULL, NULL, NULL),
  (50, 'Bank Reconciliation', 'Upload bank statements from banks to Fortnox and reconcile', NULL, '3', 'Alex Morgan', NULL, 'https://example.com/bank-statements-folder', NULL, 'not_started', 'not_started', NULL, NULL, NULL),
  (60, 'Checkout.com', 'Booking Checkout.com payouts from Power BI and reconciling against bank statements', 'Bank Reconciliation', '3', 'Jordan Lee', NULL, 'https://example.com/checkout-payouts-sheet', 'https://example.com/powerbi/checkout-payouts', 'done', 'done', NULL, NULL, NULL),
  (70, 'Tax Account Reconciliation', 'Fortnox > Accounting > Reconcile Account > [tax account] against downloaded transaction list from the tax authority', NULL, '3', 'Alex Morgan', 'Jordan Lee', 'https://example.com/tax-authority-portal', NULL, 'done', 'done', NULL, NULL, NULL),
  (80, 'Frozen/Breakage', 'Book Frozen/Breakage', NULL, '4', 'Alex Morgan', 'Jordan Lee', NULL, 'https://example.com/powerbi/frozen-breakage', 'not_started', 'done', NULL, NULL, NULL),
  (90, 'Partner Revenue Booking', 'Book the income from a payment partner. Separate out marketing costs. Reconcile balance.', NULL, '4', 'Sam Rivera', 'Jordan Lee', NULL, 'https://example.com/powerbi/partner-revenue', 'not_started', 'not_started', NULL, 'Waiting for solution on fee reporting in the data warehouse.', NULL),
  (100, 'Commission & Referral Fee Booking', 'New process for booking commission and referral fees as marketing costs. Power BI report shows amounts to book against the relevant marketing cost/payable accounts', NULL, '4', 'Alex Morgan', 'Jordan Lee', NULL, 'https://example.com/powerbi/referral-fees', 'not_started', 'not_started', NULL, 'Interesting learn. The referrals have a built in delay of 3 days, so this report can''t be used before that.', NULL),
  (110, 'Sweeping Fees Booking', 'Book Sweeping Fees', 'Average FX Rates', '4', 'Alex Morgan', 'Jordan Lee', NULL, 'https://example.com/powerbi/sweeping-fees', 'done', 'done', NULL, 'Fees returning back to lower levels.', NULL),
  (120, 'Admin & Conversion Fee Booking', 'New process for booking conversion fees.', NULL, '4', 'Alex Morgan', 'Sam Rivera', NULL, 'https://example.com/powerbi/conversion-fees', 'not_started', 'not_started', NULL, NULL, NULL),
  (130, 'Invoice Booking Monthly (IBM)', 'Book IBM in Fortnox based on Power BI summary. Remember the Fiat Payments Check.', NULL, '5', 'Alex Morgan', 'Jordan Lee', 'https://example.com/ibm-folder', 'https://example.com/powerbi/ibm-summary', 'not_started', 'not_started', NULL, 'Waiting for a bug fix upstream.', NULL),
  (140, 'Self Billing Contractors', 'Check that all Self Billing Contractors are done and approved/booked.', NULL, '7', 'Alex Morgan', 'Jordan Lee', NULL, 'https://example.com/powerbi/self-billing', 'not_started', 'not_started', NULL, NULL, NULL),
  (150, 'Accounts Payable Reconciliation', 'Fortnox > Reports > Supplier Invoices > Ledger List against Balance Sheet.', NULL, '8', 'Alex Morgan', NULL, NULL, NULL, 'not_started', 'not_started', NULL, NULL, NULL),
  (160, 'Accounts Receivable Reconciliation', 'Fortnox > Reports > Invoicing > Ledger List against Balance Sheet', NULL, '8', 'Alex Morgan', NULL, NULL, NULL, 'not_started', 'not_started', NULL, NULL, NULL),
  (170, 'Exchanges', 'Exchange-related balance sheet accounts', NULL, '8', 'Alex Morgan', 'Taylor Kim', NULL, NULL, 'not_started', 'not_started', NULL, NULL, NULL),
  (180, 'Crypto Wallets', 'Crypto wallet balance sheet accounts', NULL, '8', 'Alex Morgan', 'Sam Rivera', NULL, NULL, 'not_started', 'not_started', NULL, NULL, NULL),
  (190, 'Marketing Wallet', 'Reconcile the marketing wallet balance sheet account.', NULL, '8', 'Alex Morgan', 'Casey Nguyen', 'https://example.com/marketing-wallet-sheet', NULL, 'not_started', 'not_started', NULL, NULL, NULL),
  (200, 'Assets Booking', NULL, 'All the above', '13', 'Alex Morgan', 'Sam Rivera', 'https://example.com/assets-booking-sheet', 'https://example.com/powerbi/assets-booking', 'not_started', 'not_started', NULL, NULL, NULL),
  (210, 'CKO Revaluation', NULL, NULL, '13', 'Jordan Lee', 'Jordan Lee', NULL, 'https://example.com/powerbi/cko-revaluation', 'not_started', 'not_started', NULL, NULL, NULL),
  (220, 'VAT Checks', 'Run the VAT checks monthly to find material errors at an early stage', NULL, '14', 'Alex Morgan', 'Jordan Lee', 'https://example.com/vat-checks-sheet', 'https://example.com/powerbi/vat-checks', 'not_started', 'not_started', NULL, NULL, NULL),
  (230, 'COGS FX', NULL, NULL, '14', 'Alex Morgan', 'Sam Rivera', NULL, NULL, 'not_started', 'not_started', NULL, NULL, NULL),
  (240, 'Lock Period', 'Lock the account period in Fortnox', 'Assets Booking', '15.1', 'Alex Morgan', NULL, NULL, NULL, 'not_started', 'not_started', NULL, NULL, NULL),
  (250, 'Key Financials', 'Update Key Financials sheet and confirm with Power BI', 'Lock Period', '15.2', 'Jordan Lee', 'Sam Rivera', 'https://example.com/key-financials-sheet', 'https://example.com/powerbi/key-financials', 'not_started', 'not_started', NULL, NULL, NULL),
  (260, 'Financial Forecast Model', 'Update Financial Forecast Model', 'Key Financials', '15.3', 'Jordan Lee', 'Sam Rivera', 'https://example.com/forecast-model-sheet', NULL, 'not_started', 'not_started', NULL, NULL, NULL),
  (270, 'Statistics Reporting', NULL, NULL, '15.4', 'Jordan Lee', 'Sam Rivera', 'https://example.com/statistics-authority-portal', 'https://example.com/statistics-reporting-sheet', 'not_started', 'not_started', NULL, NULL, NULL),
  (280, 'Payroll & Vacation Accruals', 'Running the salary process and checking Vacation Accrual against Balance Sheet', NULL, '25th Prev Month', 'Alex Morgan', NULL, NULL, NULL, 'not_started', 'not_started', NULL, NULL, NULL),
  (290, 'Depreciations', 'Fortnox > Asset Register > Depreciations. Not applicable at the moment as no assets.', NULL, 'N/A', 'Alex Morgan', NULL, NULL, NULL, 'n_a', 'n_a', NULL, NULL, NULL),
  (300, 'Provider Balance Revaluation', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'not_started', 'not_started', NULL, NULL, NULL)
) AS t(sort_order, task_name, description, dependency_text, due_date, booking_responsible_name, quality_check_name, url, powerbi_url, booking_status, check_status, date_finished, comment, mg_comment)
LEFT JOIN u ur ON ur.name = t.booking_responsible_name
LEFT JOIN u uq ON uq.name = t.quality_check_name;
