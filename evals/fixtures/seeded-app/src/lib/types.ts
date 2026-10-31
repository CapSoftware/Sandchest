export type Role = "owner" | "admin" | "member" | "viewer";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  org_id: string;
  is_staff: boolean;
  created_at: string;
}

export interface Org {
  id: string;
  name: string;
  plan: "free" | "pro" | "enterprise";
  created_at: string;
}

export type InvoiceStatus = "draft" | "sent" | "paid" | "void";

export interface Invoice {
  id: string;
  org_id: string;
  number: string;
  customer_name: string;
  customer_email: string;
  status: InvoiceStatus;
  currency: string;
  total_cents: number;
  notes: string | null;
  share_token: string;
  due_at: string | null;
  created_at: string;
}

export interface LineItem {
  id: string;
  invoice_id: string;
  description: string;
  quantity: number;
  unit_cents: number;
}

export interface Webhook {
  id: string;
  org_id: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
}

export interface Session {
  userId: string;
  orgId: string;
  role: Role;
  staff: boolean;
  issuedAt: number;
}
