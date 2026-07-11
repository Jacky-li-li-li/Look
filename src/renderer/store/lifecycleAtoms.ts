import { atom } from "jotai";

export const appReadyPhaseAtom = atom(0);

export const initialDataLoadedAtom = atom((get) => get(appReadyPhaseAtom) >= 1);
