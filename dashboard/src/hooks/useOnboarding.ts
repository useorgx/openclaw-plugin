import { useState, useCallback } from 'react';

const STORAGE_KEY = 'orgx-onboarding-complete';

export function useOnboarding() {
  const [isComplete, setIsComplete] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [step, setStep] = useState(0);

  const completeOnboarding = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      // localStorage unavailable
    }
    setIsComplete(true);
  }, []);

  const resetOnboarding = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // localStorage unavailable
    }
    setIsComplete(false);
    setStep(0);
  }, []);

  const nextStep = useCallback(() => {
    setStep((s) => Math.min(s + 1, 2));
  }, []);

  const prevStep = useCallback(() => {
    setStep((s) => Math.max(s - 1, 0));
  }, []);

  return {
    isComplete,
    step,
    nextStep,
    prevStep,
    completeOnboarding,
    resetOnboarding,
  };
}
