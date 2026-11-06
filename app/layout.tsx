import type { Metadata } from "next";
import "./globals.css";
import "./config.css";
import "./map.css";
import "./map-features.css";
import "./resize.css";
import "./scanner.css";
import "./auth.css";
import "./auth-extra.css";
import "./logs.css";
import "./nav-fix.css";
import "./movements.css";
import "./backups.css";
import "./map-navigation.css";
import "./map-overview.css";
import "./nav-mode.css";
import "./multi-stock.css";
import "./capacity-outbound.css";
import "./outbound-pallet.css";
import "./unified-floor.css";
import "./map-interaction-fix.css";
import "./recent-movement.css";
import "./health.css";
import "./minimap.css";
import "./v37.css";
import "./v38.css";
import "./v39.css";
import "./v40.css";
import "./v41.css";
import "./v42.css";
import "./v43.css";
import "./v47.css";
import "./branding.css";
import "./stock-transfer.css";
import "./role-permissions.css";
import "./inventory-view.css";

import "./usability.css";
import {ModalFocus} from "../components/ModalFocus";

export const metadata: Metadata = {
  title: "海外仓电子库位图",
  description: "仓库库位、产品和箱库存、出入库及仓储费管理",
  applicationName: "电子库位图",
  icons: {
    icon: "/warehouse-logo.png",
    shortcut: "/warehouse-logo.png",
    apple: "/warehouse-logo.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}<ModalFocus/></body></html>;
}
