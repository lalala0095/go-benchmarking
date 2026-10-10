import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { EmptyState } from './components/ui';

const ChatPage = lazy(() => import('./pages/ChatPage'));
const LivePage = lazy(() => import('./pages/LivePage'));
const BenchPage = lazy(() => import('./pages/BenchPage'));
const RunPage = lazy(() => import('./pages/RunPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const ComparePage = lazy(() => import('./pages/ComparePage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));


export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/chat" replace />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="live" element={<LivePage />} />
        <Route path="bench" element={<BenchPage />} />
        <Route path="bench/:runId" element={<RunPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="compare" element={<ComparePage />} />
        <Route path="about" element={<AboutPage />} />
        <Route path="*" element={<EmptyState title="Page not found">Use the navigation above.</EmptyState>} />
      </Route>
    </Routes>
  );
}
