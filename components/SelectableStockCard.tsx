"use client";
import type {ReactNode} from 'react';
/** A card keeps native text selection; dragging a name must not activate it. */
export function SelectableStockCard({active,onSelect,children}:{active:boolean;onSelect:()=>void;children:ReactNode}){
 return <div role="button" tabIndex={0} aria-pressed={active} className={`stock-tab-select${active?' active':''}`} onClick={e=>{const selected=window.getSelection();if(selected&&!selected.isCollapsed&&selected.anchorNode&&selected.focusNode&&e.currentTarget.contains(selected.anchorNode)&&e.currentTarget.contains(selected.focusNode))return;onSelect();}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect();}}}>{children}</div>;
}
