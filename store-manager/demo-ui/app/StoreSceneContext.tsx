"use client";

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import type { StoreScene } from "./store-scene/StoreScene";

export const StoreSceneContext = createContext<StoreScene | null>(null);

/** The live 3D store, or null while it loads or when WebGL is unavailable. */
export function useStoreScene() {
  return useContext(StoreSceneContext);
}

type SceneAnchorProps = {
  at: readonly [number, number, number];
  className?: string;
  children: ReactNode;
};

/** An HTML label that follows a point in the store as the view zooms and pans. */
export function SceneAnchor({ at, className, children }: SceneAnchorProps) {
  const scene = useStoreScene();
  const ref = useRef<HTMLDivElement>(null);
  const [x, y, z] = at;

  useEffect(() => {
    const element = ref.current;
    if (!scene || !element) return;
    return scene.addAnchor(element, [x, y, z]);
  }, [scene, x, y, z]);

  return (
    <div ref={ref} className={["scene-anchor", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}
