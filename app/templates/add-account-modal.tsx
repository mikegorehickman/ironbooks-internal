"use client";

import { useState, useEffect } from "react";
import { X, Loader2, Plus, Building2, Layers } from "lucide-react";

// Common QBO account types - reference: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account
const QBO_TYPES_BY_SECTION: Record<string, string[]> = {
  revenue: ["Income", "Other Income"],
  cogs: ["Cost of Goods Sold"],
  operating_expense: ["Expense"],
  other_income: ["Other Income"],
  other_expense: ["Other Expense"],
  asset: ["Bank", "Accounts Receivable", "Other Current Asset", "Fixed Asset", "Other Asset"],
  liability: ["Accounts Payable", "Credit Card", "Other Current Liability", "Long Term Liability"],
  equity: ["Equity"],
};

// Common subtypes (not exhaustive - users can type custom)
const QBO_SUBTYPES_BY_TYPE: Record<string, string[]> = {
  "Income": ["ServiceFeeIncome", "SalesOfProductIncome", "DiscountsRefundsGiven", "OtherPrimaryIncome"],
  "Cost of Goods Sold": ["CostOfLabor", "SuppliesMaterialsCogs", "EquipmentRentalCos", "SubcontractorCosts", "OtherCostsOfServiceCos", "ShippingFreightDeliveryCos"],
  "Expense": ["AdvertisingPromotional", "PayrollExpenses", "PayrollWageExpenses", "PayrollTaxExpenses", "Auto", "Insurance", "LegalProfessionalFees", "OfficeGeneralAdministrativeExpenses", "RentOrLeaseOfBuildings", "OfficeExpenses", "Utilities", "DuesSubscriptions", "InterestPaid", "Depreciation", "Travel", "EntertainmentMeals", "RepairMaintenance", "SuppliesMaterials", "Communication", "BankCharges", "Taxes"],
  "Bank": ["CashOnHand", "Checking", "Savings", "MoneyMarket"],
  "Credit Card": ["CreditCard"],
  "Other Current Asset": ["LoansToOthers", "Inventory", "Prepayments", "EmployeeCashAdvances", "OtherCurrentAssets"],
  "Fixed Asset": ["Buildings", "Vehicles", "MachineryAndEquipment", "FurnitureAndFixtures", "AccumulatedDepreciation", "Land"],
  "Accounts Receivable": ["AccountsReceivable"],
  "Accounts Payable": ["AccountsPayable"],
  "Other Current Liability": ["SalesTaxPayable", "PayrollLiabilities", "FederalIncomeTaxPayable", "InsurancePayable", "LineOfCredit", "OtherCurrentLiabilities"],
  "Long Term Liability": ["NotesPayable", "ShareholderNotesPayable", "OtherLongTermLiabilities"],
  "Equity": ["OpeningBalanceEquity", "PartnersEquity", "RetainedEarnings", "OwnersEquity", "PaidInCapitalOrSurplus"],
};

const SECTIONS = [
  { value: "revenue", label: "Revenue" },
  { value: "cogs", label: "Cost of Goods Sold" },
  { value: "operating_expense", label: "Operating Expense" },
  { value: "other_income", label: "Other Income" },
  { value: "other_expense", label: "Other Expense" },
  { value: "asset", label: "Asset" },
  { value: "liability", label: "Liability" },
  { value: "equity", label: "Equity" },
];

interface MasterAccount {
  id: string;
  jurisdiction: "US" | "CA";
  account_name: string;
  parent_account_name: string | null;
  is_parent: boolean | null;
  qbo_account_type: string;
  qbo_account_subtype: string;
  sort_order: number;
  section: string;
  notes: string | null;
  is_required: boolean | null;
}

export function AddAccountModal({
  jurisdiction,
  industry,
  presetParent,
  existingAccounts,
  onClose,
  onAdded,
}: {
  jurisdiction: "US" | "CA";
  industry: string;
  presetParent: string | null;
  existingAccounts: MasterAccount[];
  onClose: () => void;
  onAdded: (account: any) => void;
}) {
  const [isParent, setIsParent] = useState(!presetParent);
  const [accountName, setAccountName] = useState("");
  const [parentName, setParentName] = useState(presetParent || "");
  const [section, setSection] = useState("operating_expense");
  const [qboType, setQboType] = useState("Expense");
  const [qboSubtype, setQboSubtype] = useState("");
  const [notes, setNotes] = useState("");
  const [isRequired, setIsRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If parent preset, inherit section + type from parent
  const presetParentObj = presetParent
    ? existingAccounts.find((a) => a.account_name === presetParent && a.is_parent)
    : null;

  // Auto-fill from parent on first render
  useEffect(() => {
    if (presetParentObj) {
      setSection(presetParentObj.section);
      setQboType(presetParentObj.qbo_account_type);
      setQboSubtype(presetParentObj.qbo_account_subtype);
    }
  }, []);

  const availableParents = existingAccounts.filter((a) => a.is_parent);
  const availableTypes = QBO_TYPES_BY_SECTION[section] || [];
  const availableSubtypes = QBO_SUBTYPES_BY_TYPE[qboType] || [];

  async function save() {
    setError(null);
    if (!accountName.trim()) {
      setError("Account name is required");
      return;
    }
    if (!isParent && !parentName) {
      setError("Pick a parent account or switch to parent mode");
      return;
    }
    if (!qboType || !qboSubtype) {
      setError("QBO type and subtype are required");
      return;
    }

    // Check for duplicate name in this jurisdiction
    const dup = existingAccounts.find(
      (a) => a.account_name.toLowerCase() === accountName.trim().toLowerCase()
    );
    if (dup) {
      setError(`"${accountName}" already exists in ${jurisdiction}`);
      return;
    }

    setSaving(true);

    const body = {
      account_name: accountName.trim(),
      jurisdiction,
      // Industry MUST be sent — the API used to silently default to
      // "painters" when this was missing, which caused chimney_sweepers
      // (and every other non-painter industry) to lose new additions.
      industry,
      parent_account_name: isParent ? null : parentName,
      is_parent: isParent,
      section,
      qbo_account_type: qboType,
      qbo_account_subtype: qboSubtype,
      notes: notes.trim() || null,
      is_required: isRequired,
    };

    const res = await fetch("/api/master-coa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const { error: errMsg } = await res.json();
      setError(errMsg);
      setSaving(false);
      return;
    }

    const { account } = await res.json();
    onAdded(account);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg flex items-center justify-center w-9 h-9 bg-teal-light">
              <Plus size={18} className="text-teal" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-navy">Add Account</h3>
              <p className="text-xs text-ink-slate">
                Adding to {jurisdiction === "US" ? "United States" : "Canada"}
                {presetParent && ` → under "${presetParent}"`}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X size={18} className="text-ink-slate" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-5">
          {/* Parent vs child toggle */}
          {!presetParent && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-2 text-ink-slate">
                Account Type
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setIsParent(true)}
                  className={`p-4 rounded-lg border-2 text-left transition-colors ${
                    isParent
                      ? "border-teal bg-teal-lighter"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Layers size={16} className="text-teal" />
                    <span className="font-bold text-sm text-navy">Parent Account</span>
                  </div>
                  <p className="text-xs text-ink-slate">
                    Top-level grouping (e.g., "Marketing")
                  </p>
                </button>
                <button
                  onClick={() => setIsParent(false)}
                  className={`p-4 rounded-lg border-2 text-left transition-colors ${
                    !isParent
                      ? "border-teal bg-teal-lighter"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Building2 size={16} className="text-teal" />
                    <span className="font-bold text-sm text-navy">Sub-Account</span>
                  </div>
                  <p className="text-xs text-ink-slate">
                    Under an existing parent (e.g., "Google Ads")
                  </p>
                </button>
              </div>
            </div>
          )}

          {/* Account name */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
              Account Name *
            </label>
            <input
              type="text"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder={isParent ? "e.g., Marketing" : "e.g., Google Ads"}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
              autoFocus
            />
          </div>

          {/* Parent picker */}
          {!isParent && (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
                Parent Account *
              </label>
              <select
                value={parentName}
                onChange={(e) => {
                  setParentName(e.target.value);
                  const parent = existingAccounts.find((a) => a.account_name === e.target.value);
                  if (parent) {
                    setSection(parent.section);
                    setQboType(parent.qbo_account_type);
                    setQboSubtype(parent.qbo_account_subtype);
                  }
                }}
                disabled={!!presetParent}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy bg-white disabled:bg-gray-50"
              >
                <option value="">Select parent...</option>
                {availableParents.map((p) => (
                  <option key={p.id} value={p.account_name}>
                    {p.account_name} ({p.section.replace("_", " ")})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Section */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
              Section *
            </label>
            <select
              value={section}
              onChange={(e) => {
                setSection(e.target.value);
                const types = QBO_TYPES_BY_SECTION[e.target.value] || [];
                if (types.length > 0 && !types.includes(qboType)) {
                  setQboType(types[0]);
                  setQboSubtype("");
                }
              }}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy bg-white"
            >
              {SECTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {/* QBO type + subtype */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
                QBO Account Type *
              </label>
              <select
                value={qboType}
                onChange={(e) => {
                  setQboType(e.target.value);
                  setQboSubtype("");
                }}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy bg-white"
              >
                {availableTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
                <option value="__custom__">(Type custom value below)</option>
              </select>
              {qboType === "__custom__" && (
                <input
                  type="text"
                  placeholder="Custom QBO Account Type"
                  onChange={(e) => setQboType(e.target.value)}
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
                />
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
                QBO Subtype *
              </label>
              <input
                type="text"
                value={qboSubtype}
                onChange={(e) => setQboSubtype(e.target.value)}
                list="qbo-subtypes"
                placeholder="e.g., AdvertisingPromotional"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
              />
              <datalist id="qbo-subtypes">
                {availableSubtypes.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <p className="text-xs text-ink-light mt-1">
                Type or pick from suggestions
              </p>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
              Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Tax treatment, when to use this account, etc."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy resize-none"
            />
          </div>

          {/* Required toggle */}
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={isRequired}
              onChange={(e) => setIsRequired(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-navy font-medium">Required</span>
            <span className="text-xs text-ink-slate">
              — AI will auto-create this account if missing from a client's COA
            </span>
          </label>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="text-sm font-semibold text-ink-slate hover:text-navy px-3 py-2"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !accountName}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {saving ? "Adding..." : "Add Account"}
          </button>
        </div>
      </div>
    </div>
  );
}
