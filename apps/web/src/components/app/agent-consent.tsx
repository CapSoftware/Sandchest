/** What an agent can do once connected: shown wherever a person approves one. */
export function AgentAbilities() {
  return (
    <ul className="setup-list agent-abilities">
      <li>See the findings, scans and repositories you can see.</li>
      <li>Start deep scans, and change findings and settings, as you could.</li>
      <li>Spend credits, and charge the card saved for accounts you administer. A first card payment is always made by you, on Stripe.</li>
    </ul>
  );
}
