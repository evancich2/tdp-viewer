import type { BomItem } from "../core";

export function BomTree({ items, onSelectFile }: { items: BomItem[]; onSelectFile: (path: string) => void }) {
  const children = (parent?: string) => items.filter((i) => i.parent === parent);
  const render = (item: BomItem) => (
    <li key={item.partNumber}>
      <strong>{item.partNumber}</strong> rev {item.revision} — {item.name} × {item.quantity}
      {item.files.map((f) => (
        <button key={f} className="link small" onClick={() => onSelectFile(f)}>{f.split("/").pop()}</button>
      ))}
      {children(item.partNumber).length > 0 && <ul>{children(item.partNumber).map(render)}</ul>}
    </li>
  );
  return <ul className="bom">{children(undefined).map(render)}</ul>;
}
