"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { releaseHistory } from "../lib/release-history";
import styles from "./ReleaseHistory.module.css";

export function ReleaseHistory() {
  const version = releaseHistory[0].version;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  return <>
    <button
      type="button"
      className={`site-version ${styles.badge}`}
      aria-label={`查看更新日志，当前版本 ${version}`}
      aria-haspopup="dialog"
      title="查看更新日志"
      onClick={() => setOpen(true)}
    >{version}</button>
    {open && createPortal(<dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      onClose={() => setOpen(false)}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
          event.currentTarget.close();
        }
      }}
    >
      <div className={styles.header}>
        <div>
          <h2 id={titleId}>更新日志</h2>
          <p>当前版本 {version}</p>
        </div>
        <button type="button" className={styles.close} onClick={() => dialogRef.current?.close()}>关闭</button>
      </div>
      <div className={styles.entries}>
        {releaseHistory.map(release => <section key={release.version} className={styles.entry}>
          <div className={styles.entryHeading}>
            <h3>{release.version}</h3>
            <time dateTime={release.date}>{release.date}</time>
          </div>
          <ul>{release.changes.map(change => <li key={change}>{change}</li>)}</ul>
        </section>)}
        <p className={styles.footnote}>以上按现存版本记录整理，仅显示更新日期。</p>
      </div>
    </dialog>, document.body)}
  </>;
}
