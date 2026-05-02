import "./QuoteBlock.css";

export function QuoteBlock({ quote, attribution }: { quote: string; attribution: string }) {
  return (
    <figure>
      <blockquote className="mkt-quote">"{quote}"</blockquote>
      <figcaption className="mkt-quote__attr mkt-caption">{attribution}</figcaption>
    </figure>
  );
}
