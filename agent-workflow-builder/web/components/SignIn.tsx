'use client';

import { useState } from 'react';
import { useSignInEmailPassword, useSignUpEmailPassword } from '@nhost/nextjs';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const signIn = useSignInEmailPassword();
  const signUp = useSignUpEmailPassword();
  const active = mode === 'in' ? signIn : signUp;

  const submit = async () => {
    if (mode === 'in') await signIn.signInEmailPassword(email, password);
    else await signUp.signUpEmailPassword(email, password);
  };

  return (
    <div className="shell" style={{ maxWidth: 380 }}>
      <div className="card">
        <h1>{mode === 'in' ? 'Sign in' : 'Create an account'}</h1>
        <p className="sub">An owner has to add you to an organization before you see anything.</p>

        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />

        <label htmlFor="password" style={{ marginTop: 10 }}>Password</label>
        <input id="password" type="password" value={password}
               onChange={(e) => setPassword(e.target.value)}
               onKeyDown={(e) => e.key === 'Enter' && submit()} />

        <div className="row" style={{ marginTop: 14 }}>
          <button className="primary" onClick={submit} disabled={active.isLoading}>
            {mode === 'in' ? 'Sign in' : 'Sign up'}
          </button>
          <button onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
            {mode === 'in' ? 'Create an account' : 'I already have one'}
          </button>
        </div>

        {active.isError && <p className="err sub" style={{ marginTop: 12 }}>{active.error?.message}</p>}
      </div>
    </div>
  );
}
