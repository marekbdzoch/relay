import { create } from 'zustand';

/** Lets admins reopen the first-run setup wizard later (workspace menu → Setup guide). */
export const useOnboarding = create<{ open: boolean }>(() => ({ open: false }));
export const openOnboarding = () => useOnboarding.setState({ open: true });
