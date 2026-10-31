const SHORTCUTS_HTML = `
  <ul>
    <li><kbd>N</kbd> new invoice</li>
    <li><kbd>/</kbd> search invoices</li>
    <li><kbd>G</kbd> then <kbd>S</kbd> open settings</li>
  </ul>
`;

const FAQ = [
  { question: "How do customers pay?", answer: "Send the invoice; the customer receives a link to a hosted page." },
  { question: "Can I change an invoice after sending it?", answer: "Void it and create a new one, so your records stay consistent." },
];

export default function HelpPage() {
  return (
    <article>
      <h1>Help</h1>
      <h2>Keyboard shortcuts</h2>
      <div dangerouslySetInnerHTML={{ __html: SHORTCUTS_HTML }} />
      <h2>Questions</h2>
      <dl>
        {FAQ.map((entry) => (
          <div key={entry.question}>
            <dt>{entry.question}</dt>
            <dd>{entry.answer}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
