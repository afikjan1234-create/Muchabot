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
