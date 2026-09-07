/**
 * The five answers to "איך היית מדרג את ההזמנה?" and the reasons offered when
 * the answer is a low one.
 *
 * The rating labels are duplicated inside the approved WhatsApp template
 * `order_rating` and must not drift from it: a template quick reply arrives
 * carrying nothing but its own label text, so that string is the only way back
 * to a score. Meta forbids emoji in template buttons, which is why these are
 * words rather than stars — the reason list below is a session message, where
 * emoji are allowed.
 */

export interface RatingOption {
  rating: number;
  label: string;
}

export const RATING_OPTIONS: RatingOption[] = [
  { rating: 5, label: 'היה מדהים' },
  { rating: 4, label: 'היה טוב מאוד' },
  { rating: 3, label: 'היה בסדר' },
  { rating: 2, label: 'לא היה טוב' },
  { rating: 1, label: 'היו לי בעיות בהזמנה' },
];

export const ratingRowId = (rating: number): string => `RATING_${rating}`;

/**
 * The two buttons on the retired `restaurant_ranking` template.
 *
 * Transitional: orgs stay on that template until Meta approves `order_rating`,
 * and without these a customer pressing one of its buttons falls through to
 * the "I didn't understand" path and receives a second, redundant message.
 * Delete both once no org points at the legacy template.
 */
export const LEGACY_POSITIVE_BUTTON = 'הכל היה מעולה';
export const LEGACY_MANAGER_BUTTON = 'אני מעוניין לפנות למנהל';

/**
 * Recovers the score from whatever the webhook delivered: the row id when the
 * customer used the re-prompt list, or the button's own label when they
 * answered the template itself.
 */
export function parseRating(payload: string): number | null {
  const text = payload.trim();

  const byId = text.match(/RATING_([1-5])/);
  if (byId) return parseInt(byId[1], 10);

  const exact = RATING_OPTIONS.find((o) => o.label === text);
  if (exact) return exact.rating;

  // "Everything was excellent" on the legacy template means the same as the
  // top of the new scale. Its other button is a request, not a score, and is
  // handled separately so no rating is invented for it.
  if (text.includes(LEGACY_POSITIVE_BUTTON)) return 5;

  // Longest label first, so a shorter label that happens to sit inside a
  // longer one can never claim the match.
  const contained = [...RATING_OPTIONS]
    .sort((a, b) => b.label.length - a.label.length)
    .find((o) => text.includes(o.label));
  return contained?.rating ?? null;
}

export interface ReasonOption {
  id: string;
  title: string;
  /** Null on the food row, which borrows the restaurant's own emoji. */
  emoji: string | null;
}

export const REASON_OPTIONS: ReasonOption[] = [
  { id: 'REASON_FOOD', title: 'האוכל', emoji: null },
  { id: 'REASON_DELIVERY', title: 'זמן המשלוח', emoji: '⏱️' },
  { id: 'REASON_PACKAGING', title: 'האריזה', emoji: '📦' },
  { id: 'REASON_MISSING', title: 'משהו היה חסר', emoji: '❌' },
  { id: 'REASON_OTHER', title: 'משהו אחר', emoji: '😕' },
];

/** Fallback for the food row when a restaurant has no emoji configured. */
export const DEFAULT_FOOD_EMOJI = '🍽️';

export function reasonRowTitle(option: ReasonOption, orgEmoji: string): string {
  const emoji = option.emoji ?? (orgEmoji.trim() || DEFAULT_FOOD_EMOJI);
  return `${emoji} ${option.title}`;
}

export function parseReason(payload: string): ReasonOption | null {
  const text = payload.trim();
  const byId = REASON_OPTIONS.find((o) => text.includes(o.id));
  if (byId) return byId;
  return REASON_OPTIONS.find((o) => text.includes(o.title)) ?? null;
}

/** Ratings at or below this trigger the reason list and a manager alert. */
export const NEGATIVE_RATING_MAX = 3;
