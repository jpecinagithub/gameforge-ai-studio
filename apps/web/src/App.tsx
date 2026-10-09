import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { Dashboard } from './pages/Dashboard';
import { Studio } from './pages/Studio';
import { Assets } from './pages/Assets';
import { Builds } from './pages/Builds';
import { Revisions } from './pages/Revisions';
import { Settings } from './pages/Settings';

export function App() {
  return (
    <>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects/:id" element={<Studio />} />
          <Route path="/projects/:id/assets" element={<Assets />} />
          <Route path="/projects/:id/builds" element={<Builds />} />
          <Route path="/projects/:id/revisions" element={<Revisions />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </BrowserRouter>
      {/* Vercel Web Analytics — mounted once. No PII, no secrets. */}
      <Analytics />
    </>
  );
}
