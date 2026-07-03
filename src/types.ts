export type OrgPlan = 'shared' | 'dedicated';

export interface Org {
  id: string;
  name: string;
  managerName: string;
  managerPhone: string;
  woltRatingUrl: string;
  templateName: string;
  feedbackDelayMinutes: number;
  isActive: boolean;
  createdAt: string;
  phones?: OrgPhone[];
  /** 'shared' = platform's default WhatsApp number; 'dedicated' = this org's own number. */
  plan: OrgPlan;
  /** Meta phone_number_id for this org's dedicated number. Null when plan is 'shared'. */
  whatsappPhoneNumberId: string | null;
  /** Only needed if the dedicated number lives under a different Meta Business Manager. */
  whatsappToken: string | null;
}

export interface WhatsAppCredentials {
  token: string;
  phoneNumberId: string;
}

export interface OrgPhone {
  phone: string;
  label: string;
}

export type FeedbackStatus = 'pending' | 'sending' | 'sent' | 'completed' | 'error' | 'cancelled';
export type ConversationState = 'waiting_feedback' | 'waiting_reason' | 'resolved' | null;

export interface Feedback {
  id: number;
  orgId: string;
  customerPhone: string;
  customerName: string;
  scheduledAt: string;
  sentAt: string | null;
  waMessageId: string | null;
  status: FeedbackStatus;
  conversationState: ConversationState;
  result: 'positive' | 'manager' | null;
  complaint: string | null;
  errorDetail: string | null;
  createdAt: string;
  org?: Org;
}
