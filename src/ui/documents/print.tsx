import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Print-to-PDF via the webview's own print dialog (SPEC §2: "PDF via webview
 * print-to-PDF of the same HTML template"). The document to print renders into
 * a hidden host; @media print CSS in index.css hides the app and shows only
 * the host; the system dialog offers "Save as PDF".
 */

const PrintContext = createContext<(node: ReactNode) => void>(() => {});

export function usePrint(): (node: ReactNode) => void {
  return useContext(PrintContext);
}

export function PrintProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode>(null);

  const print = useCallback((node: ReactNode) => {
    setContent(node);
  }, []);

  useEffect(() => {
    if (content === null) return;
    // Let the print host paint before the dialog freezes the page.
    const frame = requestAnimationFrame(() => {
      window.print();
      setContent(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [content]);

  return (
    <PrintContext.Provider value={print}>
      {children}
      {/* Portaled to <body>: print CSS hides #root entirely, so the host must
          live outside it. */}
      {createPortal(
        <div id="print-host" aria-hidden="true">
          {content}
        </div>,
        document.body,
      )}
    </PrintContext.Provider>
  );
}
