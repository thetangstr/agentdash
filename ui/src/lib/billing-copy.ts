// AgentDash (#790): person-facing plan copy for the Billing page. The API
// returns machine tier identifiers (free, pro_trial, pro_active,
// pro_past_due); the page must never print one raw.

const SMALL_NUMBER_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

function numberWord(n: number): string {
  return n >= 0 && n < SMALL_NUMBER_WORDS.length ? SMALL_NUMBER_WORDS[n]! : String(n);
}

function trialDaysLeft(periodEnd: string | null, now: Date): number | null {
  if (!periodEnd) return null;
  const end = new Date(periodEnd).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.ceil((end - now.getTime()) / 86_400_000);
}

export function planLabel(tier: string, periodEnd: string | null, now: Date = new Date()): string {
  switch (tier) {
    case "free":
      return "Free";
    case "pro_trial": {
      const days = trialDaysLeft(periodEnd, now);
      if (days === null) return "Pro trial";
      if (days <= 0) return "Pro trial — ends today";
      return `Pro trial — ${days} day${days === 1 ? "" : "s"} left`;
    }
    case "pro_active":
      return "Pro";
    case "pro_past_due":
      return "Pro — payment past due";
    default:
      // Unknown future tiers still get human words, never the raw identifier.
      return tier
        .split(/[_-]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ") || "Unknown plan";
  }
}

export function seatsPhrase(seatsPaid: number): string {
  const n = Math.max(0, Math.floor(seatsPaid));
  const phrase = n === 1 ? "one seat" : `${numberWord(n)} seats`;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
