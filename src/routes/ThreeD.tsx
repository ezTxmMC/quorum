import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useHub } from '@/lib/store';

/** Keep old 3D links working by opening the modeling mode in a regular chat. */
export function ThreeDPage() {
  const [id, setId] = useState<string>();
  useEffect(() => {
    const state = useHub.getState();
    const provider = state.data.settings.defaultProvider;
    setId(state.newSession({ provider, options: { ...state.data.settings.providerDefaults[provider], chatMode: 'model' } }));
  }, []);
  return id ? <Navigate to={`/chat/${id}`} replace /> : null;
}
