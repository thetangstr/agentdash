import "./LogoStrip.css";

export interface LogoItem {
  name: string;
  src?: string; // when undefined, renders a placeholder rectangle
}

export function LogoStrip({ items }: { items: LogoItem[] }) {
  return (
    <div className="mkt-logo-strip" role="list" aria-label="Customers and partners">
      {items.map((item) => (
        <div key={item.name} role="listitem" aria-label={item.name}>
          {item.src ? (
            <img src={item.src} alt={item.name} className="mkt-logo-strip__item" />
          ) : (
            <div className="mkt-logo-strip__placeholder" />
          )}
        </div>
      ))}
    </div>
  );
}
