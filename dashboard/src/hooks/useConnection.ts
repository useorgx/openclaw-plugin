import { useState, useEffect, useCallback, useRef } from 'react';
import type { ConnectionStatus } from '@/types';

export function useConnection() {
  const [status, setStatus] = useState<ConnectionStatus>('connected');
  const [lastConnected, setLastConnected] = useState<Date>(new Date());
  const retryCountRef = useRef(0);
  const maxRetries = 5;

  const checkConnection = useCallback(async () => {
    try {
      const res = await fetch('/orgx/api/status', {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        setStatus('connected');
        setLastConnected(new Date());
        retryCountRef.current = 0;
      } else {
        throw new Error('Not OK');
      }
    } catch {
      retryCountRef.current += 1;
      if (retryCountRef.current >= maxRetries) {
        setStatus('disconnected');
      } else {
        setStatus('reconnecting');
      }
    }
  }, []);

  useEffect(() => {
    const handleOnline = () => setStatus('reconnecting');
    const handleOffline = () => setStatus('disconnected');

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return { status, lastConnected, checkConnection };
}
