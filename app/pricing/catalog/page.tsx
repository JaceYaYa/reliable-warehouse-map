"use client";
import { hasPermission } from "../../../lib/permissions";

import { useEffect, useState } from "react";
import PricingCatalogWorkspace from "../../../components/PricingCatalogWorkspace";
import styles from "../../../components/PricingCatalogWorkspace.module.css";

type AuthUser = {
  role?: string;
};

export default function PricingCatalogPage() {
  const [state, setState] = useState<"loading" | "admin" | "denied" | "signed-out" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/me", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) return setState("signed-out");
        if (!response.ok) return setState("error");
        const payload = await response.json() as { user?: AuthUser };
        setState(hasPermission(payload.user,"pricing.manage") ? "admin" : "denied");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });
    return () => controller.abort();
  }, []);

  if (state === "admin") return <PricingCatalogWorkspace />;
  return (
    <main className={styles.gate}>
      <section>
        <h1>{state === "loading" ? "正在检查权限…" : state === "signed-out" ? "请先登录" : state === "denied" ? "无权访问产品目录" : "权限检查失败"}</h1>
        <p>{state === "denied" ? "请联系管理员开通计价与账单管理权限。" : "请返回电子库位图登录或稍后重试。"}</p>
        {/* Vinext 当前的 next/link 客户端 shim 会加载第二份 React，使用原生站内链接更稳定。 */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/">← 返回电子库位图</a>
      </section>
    </main>
  );
}
