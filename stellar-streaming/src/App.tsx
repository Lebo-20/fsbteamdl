import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import Hls from 'hls.js';
import { auth, db as fireDb } from './firebase';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  User as FireUser
} from 'firebase/auth';
import { doc, setDoc, getDoc, updateDoc } from 'firebase/firestore';
import {
  Home,
  Search,
  User,
  Play,
  Heart,
  MessageCircle,
  Share2,
  ChevronLeft,
  Settings as SettingsIcon,
  Clock,
  Bookmark,
  Wallet,
  Check,
  Lock,
  SkipForward,
  SkipBack,
  List,
  Mail,
  Eye,
  EyeOff,
  LogOut,
  Crown,
  ExternalLink,
  Activity,
  Pause,
  Flame,
  Tv,
  Trash2,
  RefreshCw,
  Github
} from 'lucide-react';

// Types
type Screen = 'LOGIN' | 'HOME' | 'DISCOVER' | 'PLAYER' | 'PROFILE' | 'SETTINGS' | 'MYLIST' | 'ADMIN' | 'ADULT' | 'ANIME';
const ADMIN_ID = '5888747846';

interface Video {
  id: string | number;
  title: string;
  poster: string;
  episodes: number;
  likes: string;
  isVip?: boolean;
  platform?: string;
}

const DEMO_VIDEOS: Video[] = [
  { id: 1, title: "The CEO's Secret Life", poster: "https://images.unsplash.com/photo-1536440136628-849c177e76a1?q=80&w=1000", episodes: 24, likes: "1.2M", isVip: true },
  { id: 2, title: "Romance in Seoul", poster: "https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?q=80&w=1000", episodes: 16, likes: "850K" },
  { id: 3, title: "Cyberpunk 2077: Edgerunners", poster: "https://images.unsplash.com/photo-1614728263952-84ea256f9679?q=80&w=1000", episodes: 10, likes: "2.4M", isVip: true },
  { id: 4, title: "Ancient Love Song", poster: "https://images.unsplash.com/photo-1533929736458-ca588d08c8be?q=80&w=1000", episodes: 30, likes: "400K" },
];

const SERVER_BASE = (typeof window !== 'undefined' && (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1'))
  ? `${window.location.origin}/api`
  : 'http://localhost:5001/api';
const getPlatformApi = (platform?: string) => `${SERVER_BASE}/${(platform || 'BILITV').toLowerCase()}`;
// Convert relative /api/proxy/image paths from backend into absolute URLs
const resolveProxyPoster = (url: string) => {
  if (!url) return '';
  if (url.startsWith('https://images.placeholders.dev')) return url;
  if (url.startsWith('/api/')) return `${SERVER_BASE.replace('/api', '')}${url}`;
  if (url.startsWith('http')) return `${SERVER_BASE}/proxy/image?url=${encodeURIComponent(url)}`;
  return url;
};

// Deterministic "fake likes" — same ID always gets same number (feels real, never fluctuates)
const generateLikes = (id: string | number, realLikes?: string | number): string => {
  // If real likes exist and are meaningful (not '0'), format & return them
  const real = String(realLikes || '').replace(/[^0-9.KMB]/g, '');
  if (real && real !== '0' && real.length > 0) {
    const num = parseFloat(real);
    if (!isNaN(num) && num > 0) {
      // Re-format to consistent style
      if (real.includes('M') || real.includes('B')) return real;
      if (real.includes('K')) return real;
      if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
      if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
      return String(num);
    }
  }

  // Seeded pseudo-random from string ID (deterministic, stable across renders)
  const seed = String(id).split('').reduce((acc, c) => acc * 31 + c.charCodeAt(0), 7);
  const rng = (s: number) => {
    let x = Math.sin(s) * 10000;
    return x - Math.floor(x);
  };

  const r = rng(seed);
  // Distribution weights: 60% → 10K–500K, 30% → 500K–2.5M, 10% → 2.5M–9.9M
  let count: number;
  if (r < 0.60) {
    count = Math.floor(10_000 + rng(seed + 1) * 490_000);
  } else if (r < 0.90) {
    count = Math.floor(500_000 + rng(seed + 2) * 2_000_000);
  } else {
    count = Math.floor(2_500_000 + rng(seed + 3) * 7_500_000);
  }

  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  return (count / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
};
const BOT_USERNAME = 'ShortTeamDl_bot';

const getDeviceId = () => {
  let id = localStorage.getItem('teamdl_device_id');
  if (!id) {
    id = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('teamdl_device_id', id);
  }
  return id;
};

export default function App() {
  const [screen, setScreen] = useState<Screen>('LOGIN');
  const [screenHistory, setScreenHistory] = useState<Screen[]>(['LOGIN']);
  const [fireUser, setFireUser] = useState<FireUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [telegramId, setTelegramId] = useState<string | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [myList, setMyList] = useState<Video[]>([]);
  const [watchHistory, setWatchHistory] = useState<Record<string, number>>({});
  const [selectedVideo, setSelectedVideo] = useState<any | null>(null);
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [currentStream, setCurrentStream] = useState<string | null>(null);
  const [currentEpisode, setCurrentEpisode] = useState<number | string>(1);
  const [showEpisodes, setShowEpisodes] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isVip, setIsVip] = useState(false);
  const [adminBypass, setAdminBypass] = useState(false);

  // Update isVip based on admin status
  useEffect(() => {
    if (telegramId === '5888747846') {
      setIsVip(true);
      setAdminBypass(true);
    }
  }, [telegramId]);
  const [vipUntil, setVipUntil] = useState<string | null>(null);
  const [showVipPopup, setShowVipPopup] = useState(false);
  const [subtitles, setSubtitles] = useState<any[]>([]);
  const [videoQuality, setVideoQuality] = useState(() => {
    return localStorage.getItem('videoQuality') || '1080p';
  });
  const [dataSettings, setDataSettings] = useState(() => {
    return localStorage.getItem('dataSettings') || 'Auto';
  });
  const [showTransferPopup, setShowTransferPopup] = useState(false);
  const [pendingUser, setPendingUser] = useState<FireUser | null>(null);
  const [debugLogs, setDebugLogs] = useState<{ msg: string, type: 'log' | 'error' | 'warn', time: string }[]>([]);
  const [subtitleDiagnostics, setSubtitleDiagnostics] = useState<any>(null);
  const [appSettings, setAppSettings] = useState<any>({
    maintenance_mode: 'off',
    hide_home: 'off',
    hide_discover: 'off',
    hide_search: 'off'
  });

  // Persistence States for screens
  const [discoverState, setDiscoverState] = useState({ query: '', platform: 'ALL', page: 1, results: [] as Video[], pageSize: 20 });
  const [animeState, setAnimeState] = useState({ query: '', page: 1, results: [] as Video[] });
  const [adultState, setAdultState] = useState({ query: '', page: 1, results: [] as Video[] });

  const fetchSettings = async () => {
    try {
      const res = await axios.get(`${SERVER_BASE}/settings`);
      setAppSettings(res.data);
    } catch (err) {
      console.error('Failed to fetch app settings', err);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  // Console Interceptor for Admin
  useEffect(() => {
    if (telegramId !== ADMIN_ID) return;

    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    const addLog = (msg: any, type: 'log' | 'error' | 'warn') => {
      const time = new Date().toLocaleTimeString();
      const message = typeof msg === 'object' ? JSON.stringify(msg) : String(msg);
      setDebugLogs(prev => [{ msg: message, type, time }, ...prev].slice(0, 100));
    };

    console.log = (...args) => {
      addLog(args.join(' '), 'log');
      originalLog.apply(console, args);
    };
    console.error = (...args) => {
      addLog(args.join(' '), 'error');
      originalError.apply(console, args);
    };
    console.warn = (...args) => {
      addLog(args.join(' '), 'warn');
      originalWarn.apply(console, args);
    };

    return () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    };
  }, [telegramId]);

  useEffect(() => {
    localStorage.setItem('videoQuality', videoQuality);
  }, [videoQuality]);

  useEffect(() => {
    localStorage.setItem('dataSettings', dataSettings);
    if (dataSettings === 'Low') setVideoQuality('480p');
    if (dataSettings === 'High') setVideoQuality('1080p');
    if (dataSettings === 'Auto') setVideoQuality('Auto');
  }, [dataSettings]);

  // Firebase Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFireUser(user);
      if (user) {
        const deviceId = getDeviceId();
        try {
          const userDoc = await getDoc(doc(fireDb, 'users', user.uid));
          if (userDoc.exists()) {
            const data = userDoc.data();

            if (data.deviceId && data.deviceId !== deviceId) {
              setPendingUser(user);
              setShowTransferPopup(true);
              setAuthLoading(false);
              return;
            } else if (!data.deviceId) {
              await updateDoc(doc(fireDb, 'users', user.uid), { deviceId });
            }

            setTelegramId(data.telegramId || null);
            setMyList(data.myList || []);
            setWatchHistory(data.watchHistory || {});

            // Check VIP
            if (data.telegramId) {
              const vipRes = await axios.get(`${SERVER_BASE}/vip-check/${data.telegramId}`);
              setIsVip(vipRes.data.isVip);
              setVipUntil(vipRes.data.vipUntil);
            }
          }
        } catch (e) {
          console.error('Failed to load user profile', e);
        }
        navigateTo('HOME');
        fetchHomeVideos();
      } else {
        navigateTo('LOGIN');
      }
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

  const subtitleStyles = `
    /* Native Subtitles (Backup) */
    video::cue {
      background: transparent;
      color: #ffffff;
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      font-weight: 700;
      -webkit-text-stroke: 0.5px black;
      text-shadow: 1px 1px 3px rgba(0,0,0,0.9);
    }
    .is-wide video::cue {
      font-size: 18px;
    }
    
    /* Global track positioning is managed via VTT conversion in backend */
  `;

  const navigateTo = (newScreen: Screen) => {
    if (screen === newScreen) return;
    setScreenHistory((prev: Screen[]) => [...prev, newScreen]);
    setScreen(newScreen);
  };

  const goBack = () => {
    setScreenHistory((prev: Screen[]) => {
      if (prev.length <= 1) return prev;
      const newHistory = [...prev];
      newHistory.pop();
      setScreen(newHistory[newHistory.length - 1]);
      return newHistory;
    });
  };

  const toggleMyList = async (video: Video) => {
    if (!fireUser) return;
    const isSaved = myList.some(v => v.id === video.id);
    const newList = isSaved
      ? myList.filter(v => v.id !== video.id)
      : [...myList, video];

    setMyList(newList);
    try {
      await updateDoc(doc(fireDb, 'users', fireUser.uid), { myList: newList });
    } catch (err) {
      console.error('Failed to update MyList', err);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setFireUser(null);
    setTelegramId(null);
    setIsVip(false);
    setMyList([]);
    setScreenHistory(['LOGIN']);
    setScreen('LOGIN');
  };

  const fetchHomeVideos = async () => {
    try {
      const activePlatforms = ['BILITV', 'MOBOREELS', 'REELALA', 'REELSHORT', 'DRAMABOX', 'DRAMAPOPS', 'MELOLO', 'SHORTMAX', 'FLEXTV', 'DRAMABITE', 'IDRAMA', 'GOODSHORT', 'SHORTBOX', 'DRAMAWAVE', 'SHORTSWAVE', 'VELOLO', 'HAPPYSHORT', 'RAPIDTV', 'STARDUSTTV', 'REELIFE', 'STARSHORT', 'MICRODRAMA']
        .filter(pf => appSettings[`platform_${pf.toLowerCase()}`] !== 'off');

      console.log(`[Home] Aggregating from ${activePlatforms.length} platforms with high limit`);
      const settled = await Promise.allSettled(
        activePlatforms.map(pf => axios.get(`${getPlatformApi(pf)}/home`, { params: { limit: 100 } }))
      );

      const arrays = settled.map((r, i) => {
        const pf = activePlatforms[i];
        if (r.status === 'fulfilled') {
          const dramas = r.value.data.dramas || r.value.data.data?.dramas || [];
          return dramas.map((d: any) => normalizeItem(d, pf));
        } else {
          console.error(`[Home] Platform ${activePlatforms[i]} fetch failed`);
          return [];
        }
      });

      // Interleave results for maximum variety and quantity
      const merged: Video[] = [];
      const maxLen = Math.max(...arrays.map(a => a.length), 0);
      for (let i = 0; i < maxLen; i++) {
        for (const arr of arrays) {
          if (arr[i]) merged.push(arr[i]);
        }
      }

      console.log(`[Home] Total merged titles: ${merged.length}`);
      setVideos(merged.length > 0 ? merged : DEMO_VIDEOS);
    } catch (err) {
      console.error('Fetch home failed', err);
      setVideos(DEMO_VIDEOS);
    }
  };

  const handleSelectVideo = async (video: Video) => {
    if (loading) return;
    setLoading(true);
    try {
      setSelectedVideo(video);
      setCurrentEpisode(1);

      const apiBase = getPlatformApi(video.platform);
      const langParam = (video.platform === 'REELSHORT' || video.platform === 'DRAMABOX' || video.platform === 'DRAMANOVA' || video.platform === 'SHORTSWAVE' || video.platform === 'DRAMAWAVE' || video.platform === 'REELIFE' || video.platform === 'STARSHORT' || video.platform === 'GOODSHORT') ? 'in' : 'id';

      console.log(`[Player] Fetching episodes for ${video.id} on ${video.platform}`);
      const resE = await axios.get(`${apiBase}/episodes/${video.id}`);
      const epList = resE.data.data?.list || resE.data.data || [];

      if (!Array.isArray(epList) || epList.length === 0) {
        throw new Error("Daftar episode tidak ditemukan atau kosong.");
      }

      setEpisodes(epList);
      const firstEpObj = epList[0];
      const firstEp = firstEpObj.id || firstEpObj.episNum || 1;
      const directUrl = firstEpObj.streamUrl || '';

      let streamUrl = directUrl;
      if (!streamUrl) {
        console.log(`[Player] Fetching stream for episode ${firstEp}`);
        const qParam = (videoQuality && videoQuality !== 'Auto') ? videoQuality.replace('p', '') : undefined;
        const resS = await axios.get(`${apiBase}/stream/${video.id}/${firstEp}`, {
          params: { quality: qParam, lang: langParam }
        });
        streamUrl = resS.data.data?.url || resS.data.data || '';
      }

      if (!streamUrl) {
        throw new Error("URL stream tidak ditemukan.");
      }

      setCurrentStream(streamUrl);
      setCurrentEpisode(1); // Reset to first ep
      navigateTo('PLAYER');

      // Background fetch subtitles
      try {
        const resSub = await axios.get(`${apiBase}/subtitle/${video.id}/${firstEp}`, { params: { lang: langParam } });
        const subData = resSub.data.data || resSub.data || {};
        const subList = subData.list || (Array.isArray(subData) ? subData : []);
        setSubtitles(subList);
        setSubtitleDiagnostics(subData.diagnostics || null);
      } catch (subErr) {
        console.warn("[Player] Subtitle fetch failed:", subErr);
        setSubtitles([]);
        setSubtitleDiagnostics(null);
      }
    } catch (err: any) {
      console.error('[Player] Selection failed:', err);
      const msg = err.response?.data?.message || err.message || "Terjadi kesalahan saat memuat video.";
      alert(`Gagal: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const playEpisode = async (epNum: string | number) => {
    if (!selectedVideo) return;
    const apiBase = getPlatformApi(selectedVideo.platform);
    const langParam = (selectedVideo.platform === 'REELSHORT' || selectedVideo.platform === 'DRAMABOX' || selectedVideo.platform === 'DRAMANOVA' || selectedVideo.platform === 'SHORTSWAVE' || selectedVideo.platform === 'DRAMAWAVE' || selectedVideo.platform === 'REELIFE' || selectedVideo.platform === 'STARSHORT' || selectedVideo.platform === 'GOODSHORT') ? 'in' : 'id';

    const epIndex = episodes.findIndex(ep => String(ep.id || ep.episNum || ep.number) === String(epNum));
    const displayIndex = epIndex !== -1 ? epIndex : 0;

    // VIP check: index >= 5 require VIP (episodes 6+)
    if (!isVip && displayIndex >= 5) {
      setShowVipPopup(true);
      return;
    }
    setLoading(true);
    try {
      const qParam = (videoQuality && videoQuality !== 'Auto') ? videoQuality.replace('p', '') : undefined;
      const resS = await axios.get(`${apiBase}/stream/${selectedVideo.id}/${epNum}`, {
        params: { quality: qParam, lang: langParam }
      });
      console.log('[Frontend] Stream response:', resS.data);
      const streamData = resS.data.data || resS.data;
      const finalUrl = streamData.url || streamData.videoUrl || streamData.stream_url || '';

      if (!finalUrl) {
        alert('Maaf, tautan video tidak ditemukan untuk episode ini.');
        setLoading(false);
        return;
      }

      setCurrentStream(finalUrl);
      setCurrentEpisode(epNum);

      // Fetch subtitles
      try {
        const resSub = await axios.get(`${apiBase}/subtitle/${selectedVideo.id}/${epNum}`, { params: { lang: langParam } });
        const subData = resSub.data.data || resSub.data || {};
        const subList = subData.list || (Array.isArray(subData) ? subData : []);
        setSubtitles(subList);
        setSubtitleDiagnostics(subData.diagnostics || null);
      } catch (err) {
        console.error('Subtitle fetch failed', err);
        setSubtitles([]);
        setSubtitleDiagnostics(null);
      }
    } catch (err) {
      console.error('Failed to load episode', err);
      alert('Gagal memuat video. Silakan coba lagi atau pilih episode lain.');
    } finally {
      setLoading(false);
    }
  };

  const handleNextEpisode = () => {
    if (!episodes || episodes.length === 0) {
      const nextNum = Number(currentEpisode) + 1;
      if (!isNaN(nextNum)) playEpisode(nextNum);
      return;
    }

    const currentIndex = episodes.findIndex(ep =>
      String(ep.id || ep.episNum || ep.number) === String(currentEpisode)
    );

    if (currentIndex !== -1 && currentIndex < episodes.length - 1) {
      const nextEp = episodes[currentIndex + 1];
      const nextId = nextEp.id || nextEp.episNum || nextEp.number;
      if (nextId !== undefined) playEpisode(nextId);
    } else {
      const nextNum = Number(currentEpisode) + 1;
      if (!isNaN(nextNum)) playEpisode(nextNum);
    }
  };

  const renderScreen = () => {
    switch (screen) {
      case 'LOGIN':
        return <LoginScreen onSuccess={() => { }} />;
      case 'HOME':
        return <HomeScreen
          videos={videos}
          onSelect={handleSelectVideo}
          onViewAll={() => navigateTo('DISCOVER')}
          settings={appSettings}
          adminId={telegramId}
        />;
      case 'DISCOVER':
        return <DiscoverScreen
          onSelect={handleSelectVideo}
          settings={appSettings}
          adminId={telegramId}
          persistentState={discoverState}
          setPersistentState={setDiscoverState}
        />;
      case 'PLAYER':
        return (
          <PlayerScreen
            key={`${selectedVideo?.platform}-${selectedVideo?.id}-${currentEpisode}`}
            video={selectedVideo}
            streamUrl={currentStream}
            episodes={episodes}
            currentEpisode={Number(currentEpisode)}
            subtitles={subtitles}
            subtitleDiagnostics={subtitleDiagnostics}
            onBack={goBack}
            onShowEpisodes={() => setShowEpisodes(true)}
            onNextEpisode={handleNextEpisode}
            isSaved={myList.some(v => v.id === selectedVideo?.id)}
            onToggleSave={() => selectedVideo && toggleMyList(selectedVideo)}
            telegramId={telegramId}
            setLoading={setLoading}
            onUpdateHistory={(displayNum) => {
              if (!selectedVideo || !fireUser) return;
              setWatchHistory(prev => {
                const next = { ...prev, [selectedVideo.id]: displayNum };
                updateDoc(doc(fireDb, 'users', fireUser.uid), { watchHistory: next }).catch(console.error);
                return next;
              });
            }}
            onRefresh={(ep) => playEpisode(ep)}
            settings={appSettings}
            onUpdateSetting={async (key, val) => {
              try {
                await axios.post(`${SERVER_BASE}/settings`, { key, value: val, adminId: telegramId });
                setAppSettings((prev: any) => ({ ...prev, [key]: val }));
              } catch (err) {
                console.error('Update setting failed', err);
              }
            }}
            setSubtitles={setSubtitles}
          />
        );
      case 'PROFILE':
        return <ProfileScreen
          user={fireUser} isVip={isVip} vipUntil={vipUntil} telegramId={telegramId}
          onSettings={() => navigateTo('SETTINGS')}
          onMyList={() => navigateTo('MYLIST')}
          onBack={goBack}
          onLogout={handleLogout}
          onVipUpdate={(v, u, tg) => { setIsVip(v); setVipUntil(u); setTelegramId(tg); }}
        />;
      case 'MYLIST':
        return <MyListScreen myList={myList} watchHistory={watchHistory} onSelect={handleSelectVideo} onBack={goBack} />;
      case 'SETTINGS':
        return <SettingsScreen onBack={goBack} quality={videoQuality} onQualityChange={setVideoQuality} dataSettings={dataSettings} onDataSettingsChange={setDataSettings} />;
      case 'ADMIN':
        return <AdminConsole
          logs={debugLogs}
          onBack={goBack}
          settings={appSettings}
          adminId={telegramId}
          onUpdateSetting={async (key, val) => {
            try {
              await axios.post(`${SERVER_BASE}/settings`, { key, value: val, adminId: telegramId });
              setAppSettings((prev: any) => ({ ...prev, [key]: val }));
            } catch (err) {
              console.error('Failed to update setting', err);
            }
          }}
        />;
      case 'ADULT':
        return <AdultScreen
          onSelect={handleSelectVideo}
          settings={appSettings}
          adminId={telegramId}
          persistentState={adultState}
          setPersistentState={setAdultState}
        />;
      case 'ANIME':
        return <AnimeScreen
          onSelect={handleSelectVideo}
          settings={appSettings}
          adminId={telegramId}
          persistentState={animeState}
          setPersistentState={setAnimeState}
        />;
    }
  };

  if (authLoading) {
    return (
      <div className="h-screen w-screen bg-[#131315] flex flex-col items-center justify-center">
        <div className="relative flex items-center justify-center h-20 w-20 mb-4">
          <div className="water-drop"></div>
          <div className="water-ripple"></div>
        </div>
        <div className="loading-text">Loading</div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-[#131315] text-white overflow-hidden relative">
      <style>{subtitleStyles}</style>
      {renderScreen()}

      {/* Bottom Navigation (Only on Home/Discover/Profile) */}
      {(screen === 'HOME' || screen === 'PROFILE' || screen === 'DISCOVER' || screen === 'ADMIN' || screen === 'ADULT' || screen === 'ANIME') && (
        <nav className="absolute bottom-0 left-0 right-0 h-16 glass flex items-center justify-around px-4 pb-2 z-50">
          {(appSettings.hide_home === 'off' || telegramId === ADMIN_ID) && (
            <NavItem icon={<Home size={24} />} label="Home" active={screen === 'HOME'} onClick={() => navigateTo('HOME')} />
          )}
          {(appSettings.hide_discover === 'off' || telegramId === ADMIN_ID) && (
            <NavItem icon={<Search size={24} />} label="Discover" active={screen === 'DISCOVER'} onClick={() => navigateTo('DISCOVER')} />
          )}
          <NavItem icon={<Tv size={24} />} label="Anime" active={screen === 'ANIME'} onClick={() => navigateTo('ANIME')} />
          {(appSettings.platform_adult !== 'off' || telegramId === ADMIN_ID) && (
            <NavItem icon={<Flame size={24} />} label="18+" active={screen === 'ADULT'} onClick={() => navigateTo('ADULT')} />
          )}
          {telegramId === ADMIN_ID && (
            <NavItem icon={<Activity size={24} />} label="Admin" active={screen === 'ADMIN'} onClick={() => navigateTo('ADMIN')} />
          )}
          <NavItem icon={<User size={24} />} label="Profile" active={screen === 'PROFILE'} onClick={() => navigateTo('PROFILE')} />
        </nav>
      )}

      {/* Episode Selection Modal */}
      {showEpisodes && (
        <EpisodeModal
          video={selectedVideo}
          episodes={episodes}
          currentEpisode={currentEpisode}
          isVip={isVip}
          onClose={() => setShowEpisodes(false)}
          onSelectEpisode={(ep) => {
            playEpisode(ep);
            setShowEpisodes(false);
          }}
        />
      )}

      {/* Confirm Device Transfer Popup */}
      {showTransferPopup && (
        <ConfirmPopup
          title="Akses Terdeteksi"
          message="Akun ini sudah login di perangkat lain. Pindahkan akses ke perangkat ini?"
          confirmLabel="Pindahkan"
          cancelLabel="Keluar"
          onConfirm={async () => {
            if (pendingUser) {
              await updateDoc(doc(fireDb, 'users', pendingUser.uid), { deviceId: getDeviceId() });
              setShowTransferPopup(false);
              setPendingUser(null);
              // Trigger reload profile or just navigate
              window.location.reload();
            }
          }}
          onCancel={async () => {
            await signOut(auth);
            setFireUser(null);
            setShowTransferPopup(false);
            setPendingUser(null);
            navigateTo('LOGIN');
          }}
        />
      )}

      {/* VIP Purchase Popup */}
      {showVipPopup && (
        <VipPopup onClose={() => setShowVipPopup(false)} />
      )}

      {loading && (
        <div className="absolute inset-0 z-[200] bg-black/40 backdrop-blur-md flex flex-col items-center justify-center">
          <div className="relative flex items-center justify-center h-20 w-20 mb-4">
            <div className="water-drop"></div>
            <div className="water-ripple"></div>
          </div>
          <div className="loading-text">Loading</div>
        </div>
      )}
    </div>
  );
}

// --- Components ---

// Login / Register Screen
function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [tgId, setTgId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const deviceId = getDeviceId();
      if (isLogin) {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        const userDoc = await getDoc(doc(fireDb, 'users', cred.user.uid));
        if (userDoc.exists()) {
          const data = userDoc.data();
          if (data.deviceId && data.deviceId !== deviceId) {
            await updateDoc(doc(fireDb, 'users', cred.user.uid), { deviceId });
          } else if (!data.deviceId) {
            await updateDoc(doc(fireDb, 'users', cred.user.uid), { deviceId });
          }
        }
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await setDoc(doc(fireDb, 'users', cred.user.uid), {
          email,
          telegramId: tgId || null,
          createdAt: new Date().toISOString(),
          isVip: false,
          deviceId,
          myList: []
        });
      }
    } catch (err: any) {
      const msg = err.code === 'auth/user-not-found' ? 'Akun tidak ditemukan'
        : err.code === 'auth/wrong-password' ? 'Password salah'
          : err.code === 'auth/email-already-in-use' ? 'Email sudah terdaftar'
            : err.code === 'auth/weak-password' ? 'Password minimal 6 karakter'
              : err.code === 'auth/invalid-email' ? 'Format email tidak valid'
                : err.message || 'Terjadi kesalahan';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full w-full flex flex-col items-center justify-center p-8 relative overflow-hidden">
      {/* Background Glow */}
      <div className="absolute top-[-200px] left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-[#A855F7]/10 rounded-full blur-[120px]" />

      <div className="z-10 w-full max-w-sm space-y-8">
        {/* Logo */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-black bg-gradient-to-r from-[#A855F7] to-purple-400 bg-clip-text text-transparent">TeamDl</h1>
          <p className="text-xs text-gray-500 tracking-[0.3em] uppercase">Streaming Platform</p>
        </div>

        {/* Tab Switcher */}
        <div className="flex glass rounded-xl p-1">
          <button
            onClick={() => { setIsLogin(true); setError(''); }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition-all ${isLogin ? 'bg-[#A855F7] text-white' : 'text-gray-400'}`}
          >
            Masuk
          </button>
          <button
            onClick={() => { setIsLogin(false); setError(''); }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition-all ${!isLogin ? 'bg-[#A855F7] text-white' : 'text-gray-400'}`}
          >
            Daftar
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email */}
          <div className="relative">
            <Mail size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              required
              className="w-full pl-12 pr-4 py-3.5 glass rounded-xl text-sm bg-white/5 border border-white/10 focus:border-[#A855F7]/50 focus:outline-none transition-colors placeholder:text-gray-600"
            />
          </div>

          {/* Password */}
          <div className="relative">
            <Lock size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
              className="w-full pl-12 pr-12 py-3.5 glass rounded-xl text-sm bg-white/5 border border-white/10 focus:border-[#A855F7]/50 focus:outline-none transition-colors placeholder:text-gray-600"
            />
            <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500">
              {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          {/* Telegram ID (only on register) */}
          {!isLogin && (
            <div className="relative">
              <User size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                value={tgId}
                onChange={(e) => setTgId(e.target.value)}
                placeholder="Telegram ID (opsional)"
                className="w-full pl-12 pr-4 py-3.5 glass rounded-xl text-sm bg-white/5 border border-white/10 focus:border-[#A855F7]/50 focus:outline-none transition-colors placeholder:text-gray-600"
              />
              <p className="text-[10px] text-gray-500 mt-1.5 ml-1">Hubungkan dengan bot untuk cek VIP</p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400 text-center">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 bg-[#A855F7] rounded-xl font-bold text-sm hover:bg-[#9333EA] transition-colors disabled:opacity-50 active:scale-[0.98]"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto" />
            ) : (
              isLogin ? 'Masuk' : 'Daftar Akun'
            )}
          </button>
        </form>

        <p className="text-center text-[10px] text-gray-600">
          Dengan melanjutkan, Anda menyetujui Syarat & Ketentuan kami
        </p>
      </div>
    </div>
  );
}

// Custom Confirmation Popup (Styled like other modals)
function ConfirmPopup({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }: {
  title: string,
  message: string,
  confirmLabel: string,
  cancelLabel: string,
  onConfirm: () => void,
  onCancel: () => void
}) {
  return (
    <div className="absolute inset-0 z-[400] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-md" />
      <div className="glass rounded-3xl p-8 z-10 w-full max-w-sm border border-white/10 space-y-6 animate-scale-in">
        <div className="flex justify-center">
          <div className="w-16 h-16 rounded-full bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
            <Activity size={32} className="text-amber-500" />
          </div>
        </div>

        <div className="text-center space-y-2">
          <h3 className="text-xl font-bold">{title}</h3>
          <p className="text-sm text-gray-400 leading-relaxed">{message}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={onCancel}
            className="py-3.5 glass rounded-xl text-sm text-gray-300 font-bold hover:bg-white/5 transition-all"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="py-3.5 bg-[#A855F7] rounded-xl font-bold text-sm hover:bg-[#9333EA] shadow-[0_0_20px_rgba(168,85,247,0.3)] transition-all active:scale-[0.98]"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// VIP Purchase Popup
function VipPopup({ onClose }: { onClose: () => void }) {
  const handleBuyVip = () => {
    window.open(`https://t.me/${BOT_USERNAME}?start=buyvip`, '_blank');
  };

  return (
    <div className="absolute inset-0 z-[300] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={onClose} />
      <div className="glass rounded-3xl p-6 z-10 w-full max-w-sm border border-white/10 space-y-5">
        {/* Crown Icon */}
        <div className="flex justify-center">
          <div className="w-20 h-20 rounded-full bg-gradient-to-br from-[#A855F7] to-purple-600 flex items-center justify-center shadow-[0_0_40px_rgba(168,85,247,0.3)]">
            <Crown size={40} className="text-white" />
          </div>
        </div>

        <div className="text-center space-y-2">
          <h3 className="text-xl font-bold">Upgrade ke VIP</h3>
          <p className="text-xs text-gray-400 leading-relaxed">
            Episode ini terkunci. Beli paket VIP untuk membuka semua episode tanpa batas!
          </p>
        </div>

        {/* VIP Benefits */}
        <div className="space-y-2">
          {[
            'Unlock semua episode tanpa batas',
            'Kualitas video hingga 1080p',
            'Tanpa iklan',
            'Akses konten eksklusif'
          ].map((benefit, i) => (
            <div key={i} className="flex items-center space-x-3 p-2">
              <Check size={14} className="text-[#A855F7] flex-shrink-0" />
              <span className="text-xs text-gray-300">{benefit}</span>
            </div>
          ))}
        </div>

        {/* CTA Buttons */}
        <div className="space-y-3 pt-2">
          <button
            onClick={handleBuyVip}
            className="w-full py-3.5 bg-[#A855F7] rounded-xl font-bold text-sm flex items-center justify-center space-x-2 hover:bg-[#9333EA] transition-colors active:scale-[0.98]"
          >
            <ExternalLink size={16} />
            <span>Beli VIP via @{BOT_USERNAME}</span>
          </button>
          <button
            onClick={onClose}
            className="w-full py-3 glass rounded-xl text-xs text-gray-400 font-bold"
          >
            Nanti Saja
          </button>
        </div>
      </div>
    </div>
  );
}

function AdminConsole({ logs, onBack, settings, onUpdateSetting, adminId }: {
  logs: any[], onBack: () => void, settings: any, onUpdateSetting: (key: string, val: string) => void, adminId: string | null
}) {
  const [activeTab, setActiveTab] = useState<'logs' | 'maintenance'>('logs');
  const [updating, setUpdating] = useState(false);

  const handleUpdate = async (type: 'quick' | 'full') => {
    if (!window.confirm(`Yakin ingin melakukan update ${type.toUpperCase()}? Web mungkin tidak dapat diakses sejenak (1-5 menit).`)) return;
    setUpdating(true);
    try {
      const res = await axios.post(`${SERVER_BASE}/admin/system/update`, { type });
      alert('Update Berhasil!\n' + (res.data.output || 'Sistem telah diperbarui dan di-restart.'));
      window.location.reload();
    } catch (err: any) {
      alert('Update Gagal: ' + (err.response?.data?.details || err.response?.data?.error || err.message));
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#050505]">
      <header className="px-6 py-8 glass border-b border-white/5 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <button onClick={onBack} className="p-2.5 glass rounded-full hover:bg-white/10 transition-colors">
              <ChevronLeft size={22} />
            </button>
            <div>
              <h2 className="text-xl font-bold tracking-tight">Admin Control</h2>
              <p className="text-[10px] text-[#A855F7] font-bold uppercase tracking-widest mt-0.5">System Management</p>
            </div>
          </div>
          <Activity size={20} className="text-[#A855F7] animate-pulse" />
        </div>

        {/* Tab Switcher */}
        <div className="flex glass rounded-xl p-1">
          <button
            onClick={() => setActiveTab('logs')}
            className={`flex-1 py-2 rounded-lg text-[10px] font-bold transition-all ${activeTab === 'logs' ? 'bg-[#A855F7] text-white' : 'text-gray-400'}`}
          >
            SYSTEM LOGS
          </button>
          <button
            onClick={() => setActiveTab('maintenance')}
            className={`flex-1 py-2 rounded-lg text-[10px] font-bold transition-all ${activeTab === 'maintenance' ? 'bg-[#A855F7] text-white' : 'text-gray-400'}`}
          >
            MAINTENANCE
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-5 font-mono text-[10px] space-y-3 bg-black/40">
        {activeTab === 'logs' ? (
          <>
            {logs.map((log, i) => (
              <div key={i} className={`p-3 rounded-xl border transition-all hover:scale-[1.01] ${log.type === 'error' ? 'bg-red-500/5 border-red-500/20 text-red-400/90' :
                  log.type === 'warn' ? 'bg-yellow-500/5 border-yellow-500/20 text-yellow-400/90' :
                    'bg-white/[0.02] border-white/5 text-gray-300'
                }`}>
                <div className="flex justify-between items-start mb-1.5 opacity-60">
                  <span className="font-bold uppercase text-[9px] tracking-tighter">[{log.type}]</span>
                  <span className="text-[9px]">{log.time}</span>
                </div>
                <div className="break-all whitespace-pre-wrap leading-relaxed">
                  {log.msg}
                </div>
              </div>
            ))}
            {logs.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 space-y-4 opacity-50">
                <Activity size={48} className="text-gray-700" />
                <p className="text-xs">No system logs captured yet.</p>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-6 font-sans">
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest px-2">Visibility Controls</h3>

              <MaintenanceToggle
                label="Home Screen"
                description="Hide home page content from regular users"
                active={settings.hide_home === 'on'}
                onToggle={() => onUpdateSetting('hide_home', settings.hide_home === 'on' ? 'off' : 'on')}
              />

              <MaintenanceToggle
                label="Discover & Search"
                description="Hide search and platform filters"
                active={settings.hide_discover === 'on'}
                onToggle={() => onUpdateSetting('hide_discover', settings.hide_discover === 'on' ? 'off' : 'on')}
              />

              <MaintenanceToggle
                label="Maintenance Mode"
                description="Global maintenance alert for all users"
                active={settings.maintenance_mode === 'on'}
                onToggle={() => onUpdateSetting('maintenance_mode', settings.maintenance_mode === 'on' ? 'off' : 'on')}
              />

              <MaintenanceToggle
                label="Demo Content"
                description="Show/Hide demo videos when platform is empty"
                active={settings.show_demo !== 'off'}
                onToggle={() => onUpdateSetting('show_demo', settings.show_demo === 'off' ? 'on' : 'off')}
              />
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest px-2">Subtitle Settings</h3>
              <div className="p-5 glass rounded-2xl border-white/5 flex items-center justify-between">
                <div className="space-y-1">
                  <h4 className="text-sm font-bold">Default Language</h4>
                  <p className="text-[10px] text-gray-500">Auto-select this language across all platforms</p>
                </div>
                <div className="flex space-x-2">
                  {['id', 'en'].map(l => (
                    <button
                      key={l}
                      onClick={() => onUpdateSetting('default_subtitle_lang', l)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase ${settings.default_subtitle_lang === l ? 'bg-[#A855F7] text-white' : 'glass text-gray-400'}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest px-2">VPS Management</h3>
              <div className="grid grid-cols-2 gap-3">
                <button
                  disabled={updating}
                  onClick={() => handleUpdate('quick')}
                  className="flex flex-col items-center justify-center p-4 glass rounded-2xl border-white/5 hover:bg-white/5 transition-all space-y-2 disabled:opacity-50"
                >
                  <RefreshCw size={20} className={updating ? 'animate-spin' : ''} />
                  <span className="text-[10px] font-bold">Quick Update</span>
                </button>
                <button
                  disabled={updating}
                  onClick={() => handleUpdate('full')}
                  className="flex flex-col items-center justify-center p-4 glass rounded-2xl border-white/5 hover:bg-white/5 transition-all space-y-2 disabled:opacity-50"
                >
                  <Github size={20} className={updating ? 'animate-pulse' : ''} />
                  <span className="text-[10px] font-bold">Full Rebuild</span>
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest px-2">System Actions</h3>
              <button
                onClick={() => {
                  if (window.confirm('Wipe system logs and cache?')) {
                    axios.post(`${SERVER_BASE}/admin/clear-logs`).then(() => alert('Logs cleared'));
                  }
                }}
                className="w-full flex items-center justify-between p-5 glass rounded-2xl border-red-500/20 bg-red-500/5 hover:bg-red-500/10 transition-all text-red-200"
              >
                <div className="text-left space-y-1">
                  <p className="font-bold">Clear Cache & Logs</p>
                  <p className="text-[10px] opacity-60">Wipe server-side cache and reset logs</p>
                </div>
                <Trash2 size={20} />
              </button>
            </div>

            <div className="space-y-4 pt-4">
              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest px-2">Platform Controls</h3>
              <div className="grid grid-cols-1 gap-2">
                {['BILITV', 'MOBOREELS', 'REELALA', 'REELSHORT', 'DRAMABOX', 'DRAMAPOPS', 'MELOLO', 'SHORTMAX', 'FLEXTV', 'DRAMABITE', 'IDRAMA', 'GOODSHORT', 'SHORTBOX', 'DRAMAWAVE', 'SHORTSWAVE', 'VELOLO', 'HAPPYSHORT', 'RAPIDTV', 'STARDUSTTV', 'REELIFE', 'STARSHORT', 'MICRODRAMA', 'ADULT', 'ANIME'].map(pf => (
                  <MaintenanceToggle
                    key={pf}
                    label={pf}
                    description={`Enable/Disable ${pf} content`}
                    active={settings[`platform_${pf.toLowerCase()}`] !== 'off'}
                    onToggle={() => onUpdateSetting(`platform_${pf.toLowerCase()}`, settings[`platform_${pf.toLowerCase()}`] === 'off' ? 'on' : 'off')}
                    mini
                  />
                ))}
              </div>
            </div>

            <div className="p-4 glass rounded-2xl border-amber-500/20 bg-amber-500/5">
              <div className="flex space-x-3">
                <Activity size={18} className="text-amber-500 shrink-0" />
                <p className="text-[11px] text-amber-200/70 leading-relaxed">
                  Admin (Anda) tetap dapat melihat semua menu meskipun maintenance aktif untuk keperluan pengetesan.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MaintenanceToggle({ label, description, active, onToggle, mini }: { label: string, description: string, active: boolean, onToggle: () => void, mini?: boolean }) {
  return (
    <div className={`${mini ? 'p-3' : 'p-5'} glass rounded-2xl border-white/5 flex items-center justify-between`}>
      <div className="space-y-1">
        <h4 className={`${mini ? 'text-xs' : 'text-sm'} font-bold`}>{label}</h4>
        {!mini && <p className="text-[10px] text-gray-500">{description}</p>}
      </div>
      <button
        onClick={onToggle}
        className={`${mini ? 'w-10 h-5' : 'w-12 h-6'} rounded-full p-1 transition-all duration-300 ${active ? 'bg-[#A855F7]' : 'bg-gray-800'}`}
      >
        <div className={`${mini ? 'w-3 h-3' : 'w-4 h-4'} bg-white rounded-full transition-all duration-300 ${active ? (mini ? 'translate-x-5' : 'translate-x-6') : 'translate-x-0'}`} />
      </button>
    </div>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: any, label: string, active: boolean, onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-col items-center justify-center w-14 transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] cursor-pointer ${active ? 'text-[#A855F7] -translate-y-4' : 'text-gray-400 active:scale-90 hover:text-gray-300'
        }`}
    >
      <div className={`transition-all duration-300 flex items-center justify-center ${active ? 'bg-[#131315] p-3 rounded-full ring-[4px] ring-[#131315] shadow-[0_8px_15px_rgba(168,85,247,0.3)]' : 'p-1'
        }`}>
        {icon}
      </div>
      <span className={`text-[10px] mt-0.5 transition-all duration-300 whitespace-nowrap ${active ? 'font-bold opacity-100 translate-y-1.5' : 'font-medium opacity-80'
        }`}>
        {label}
      </span>
    </button>
  );
}

function HomeScreen({ videos, onSelect, onViewAll, settings, adminId }: {
  videos: Video[],
  onSelect: (v: Video) => void,
  onViewAll: () => void,
  settings: any,
  adminId: string | null
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const featuredVideos = (videos.length > 0 ? videos : DEMO_VIDEOS)
    .filter(v => !v.platform || settings[`platform_${v.platform.toLowerCase()}`] !== 'off')
    .slice(0, 5);
  const featured = featuredVideos[currentIndex];

  if (settings.hide_home === 'on' && adminId !== ADMIN_ID) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center space-y-4">
        <Activity size={64} className="text-[#A855F7] opacity-50 animate-pulse" />
        <h2 className="text-xl font-bold">Sedang Pemeliharaan</h2>
        <p className="text-sm text-gray-400">Menu ini sedang dalam pemeliharaan rutin. Silakan kembali lagi nanti.</p>
      </div>
    );
  }


  useEffect(() => {
    if (featuredVideos.length <= 1) return;
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % featuredVideos.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [featuredVideos.length]);

  return (
    <div className="h-full overflow-y-auto pb-20">
      {/* Top Bar */}
      <header className="px-6 py-4 flex justify-between items-center">
        <h1 className="text-xl font-bold italic tracking-tighter text-[#A855F7]">TeamDl</h1>
        <div className="w-10 h-10 rounded-full glass flex items-center justify-center">
          <Crown size={20} className="text-[#A855F7]" />
        </div>
      </header>

      {/* Featured Poster Carousel */}
      <div className="px-6 mb-6">
        <div className="relative aspect-[16/10] rounded-2xl overflow-hidden shadow-2xl group transition-all duration-700" onClick={() => onSelect(featured)}>
          {/* Blurred Backdrop */}
          <div
            key={`bg-${featured.id}`}
            className="absolute inset-0 bg-cover bg-center scale-110 blur-xl opacity-50 animate-fade-in"
            style={{ backgroundImage: `url(${featured.poster})` }}
          />
          {/* Main Content Container */}
          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
            <img key={`img-${featured.id}`} src={featured.poster || 'https://media.publit.io/file/No-Poster.png'} className="h-full w-auto object-contain relative z-10 animate-scale-in" alt="featured" />
          </div>

          <div className="absolute inset-0 teamdl-gradient flex flex-col justify-end p-5 z-20">
            {featured.platform && (
              <span className="absolute top-3 right-3 bg-white/20 backdrop-blur-md text-[9px] font-bold px-2 py-1 rounded-full border border-white/10 uppercase tracking-widest">{featured.platform}</span>
            )}

            {/* Carousel Dots */}
            <div className="absolute top-4 left-6 flex space-x-1.5 z-30">
              {featuredVideos.map((_, i) => (
                <div key={i} className={`h-1 rounded-full transition-all duration-300 ${i === currentIndex ? 'w-4 bg-[#A855F7]' : 'w-1 bg-white/30'}`} />
              ))}
            </div>

            <h2 key={`title-${featured.id}`} className="text-xl font-bold mb-1 drop-shadow-lg animate-slide-up">{featured.title}</h2>
            <div className="flex items-center space-x-3 mb-3 text-[11px] text-gray-300 font-medium drop-shadow-md">
              <span>{featured.episodes} Episodes</span>
              <span>•</span>
              <span>{featured.likes} Likes</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onSelect(featured); }}
              className="w-full bg-[#A855F7] py-2.5 rounded-eight text-sm font-bold flex items-center justify-center space-x-2 active:scale-95 transition-all shadow-lg"
            >
              <Play fill="white" size={16} />
              <span>Watch Now</span>
            </button>
          </div>
        </div>
      </div>

      {/* Categories */}
      <div className="px-6 space-y-8">
        <section>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-bold">Trending Hub</h3>
            <button
              onClick={onViewAll}
              className="text-xs text-[#A855F7] font-semibold hover:underline cursor-pointer"
            >
              View All
            </button>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {(videos.length > 0 ? videos : DEMO_VIDEOS)
              .filter(v => {
                if (!v.platform) return settings.show_demo !== 'off';
                return settings[`platform_${v.platform.toLowerCase()}`] !== 'off';
              })
              .map((v, i) => (
                <div key={`${v.platform || 'demo'}-${v.id}-${i}`} className="space-y-1 group" onClick={() => onSelect(v)}>
                  <div className="relative aspect-[9/13] rounded-eight overflow-hidden glass border-white/5">
                    <img 
                      src={v.poster || 'https://images.placeholders.dev/?width=300&height=450&text=No+Poster&theme=dark'} 
                      onError={(e) => { (e.target as HTMLImageElement).src = 'https://images.placeholders.dev/?width=300&height=450&text=No+Poster&theme=dark'; }}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
                      alt={v.title} 
                    />
                    {v.isVip && (
                      <span className="absolute top-1 left-1 bg-[#A855F7] text-[8px] font-bold px-1.5 py-0.5 rounded shadow-lg">VIP</span>
                    )}
                    {v.platform && (
                      <span className="absolute top-1 right-1 bg-black/60 backdrop-blur-md text-[7px] font-bold px-1 py-0.5 rounded-full border border-white/5 uppercase">{v.platform}</span>
                    )}
                    <div className="absolute bottom-1 left-1 bg-black/60 backdrop-blur-md px-1.5 py-0.5 rounded text-[8px] font-bold">
                      EP {v.episodes}
                    </div>
                  </div>
                  <p className="text-[10px] font-semibold truncate leading-tight">{v.title}</p>
                </div>
              ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// Helper to extract posters with many fallbacks
const extractPoster = (d: any) => {
  const raw = d.poster || d.cover || d.image || d.thumb || d.cover_image || d.thumb_url || 
              d.vertical_cover || d.poster_url || d.cover_url || d.image_url || d.coverUrl || 
              d.poster_img || d.cover_img || d.book_pic || d.coverWap || d.posterSmall || 
              d.thumbnail || d.short_play_cover || d.video_cover || d.cover_image_thumb?.thumb ||
              d.pic || d.img || d.thumbnail_url || d.image_path || d.cover_path || 
              d.dramaCover || d.videoCover || d.verticalCover || d.coverVertical || 
              d.drama_cover || d.video_poster || d.item_cover || d.cover_vertical || 
              d.cover_horizontal || d.pic_url || d.img_url || d.image_url_vertical || '';
  const final = raw || 'https://images.placeholders.dev/?width=300&height=450&text=No+Poster&theme=dark';
  return resolveProxyPoster(final);
};

// Helper to extract titles with many fallbacks
const extractTitle = (d: any) => {
  return d.title || d.name || d.book_name || d.drama_name || d.series_name || 
         d.bookName || d.dramaName || d.seriesName || d.short_play_name || 
         d.videoName || d.book_title || d.shortplay_name || d.drama_title || 
         d.item_title || d.content_name || d.subject || '';
};

// Normalize a raw item from any platform into a Video
const normalizeItem = (d: any, platformName: string): Video => {
  const pf = String(platformName).toUpperCase();
  const poster = extractPoster(d);
  const title = extractTitle(d);
  const id = String(d.id || d.book_id || d.series_id || d.playlet_id || d.shortplay_id || d.videoid || d.drama_id || d.code || d.key || d.dramaId || Math.random());

  if (pf === 'REELALA') {
    return {
      id, title,
      poster: d.cover_url || poster,
      episodes: d.total_chapters || d.episodes || 0,
      likes: generateLikes(id, d.score || d.likes),
      platform: 'REELALA'
    };
  }
  if (pf === 'REELSHORT') {
    return {
      id,
      title: d.book_title || title,
      poster: d.book_pic || poster,
      episodes: d.chapter_count || d.episodes || 0,
      likes: generateLikes(id, d.read_count),
      platform: 'REELSHORT'
    };
  }
  if (pf === 'DRAMABOX') {
    return {
      id,
      title: d.bookName || title,
      poster: d.coverWap || poster,
      episodes: d.chapterCount || d.episodes || 0,
      likes: generateLikes(id, d.likes || d.hotCode),
      platform: 'DRAMABOX'
    };
  }
  if (pf === 'SHORTMAX') {
    return {
      id, title, poster,
      episodes: d.episodes || d.total || 0,
      likes: generateLikes(id, d.likes || d.views),
      platform: 'SHORTMAX'
    };
  }
  if (pf === 'MELOLO') {
    const rawCount = parseInt(String(d.read_count || d.play_count || 0));
    return {
      id, title,
      poster: d.thumb_url || poster,
      episodes: d.episodes || d.serial_count || d.episode_count || d.total_episodes || 0,
      likes: generateLikes(id, rawCount),
      platform: 'MELOLO'
    };
  }
  if (pf === 'SHORTSWAVE') {
    return {
      id, title, poster,
      episodes: d.episodes || d.total_episodes || 0,
      likes: generateLikes(id, d.likes || d.hot),
      platform: 'SHORTSWAVE'
    };
  }
  if (pf === 'FUNDRAMA') {
    return {
      id, title, poster,
      episodes: d.episodes || 0,
      likes: generateLikes(id, d.likes),
      platform: 'FUNDRAMA'
    };
  }
  if (pf === 'DRAMAPOPS') {
    return {
      id, title,
      poster: d.posterSmall || poster,
      episodes: parseInt(d.totalEpisodes) || 0,
      likes: generateLikes(id, d.watchCount),
      platform: 'DRAMAPOPS'
    };
  }
  if (pf === 'GOODSHORT') {
    return {
      id, title,
      poster: resolveProxyPoster(poster),
      episodes: parseInt(d.chapterCount || d.episodes) || 0,
      likes: generateLikes(id, d.viewCount || d.viewCountDisplay),
      platform: 'GOODSHORT'
    };
  }
  if (pf === 'MICRODRAMA') {
    return {
      id, title,
      poster: resolveProxyPoster(poster),
      episodes: d.total_episodes || d.episodes || 0,
      likes: generateLikes(id, d.views || d.viewCount),
      platform: 'MICRODRAMA'
    };
  }
  if (pf === 'SHORTBOX') {
    return {
      id, title,
      poster: d.cover_image || d.cover_image_thumb?.thumb || poster,
      episodes: d.total || d.episodes || 0,
      likes: generateLikes(id, d.viewCountDisplay),
      platform: 'SHORTBOX'
    };
  }

  // Default fallback for any other platform (including VELOLO, DRAMAWAVE, ADULT, ANIME etc.)
  return {
    id,
    title: title || 'Drama Untitled',
    poster: poster,
    episodes: parseInt(d.episodes || d.total_episodes || d.chapter_count || d.total || d.episode_count || d.count || d.totalEpisodeNum || 0) || 0,
    likes: generateLikes(id, d.likes || d.click_num || d.score || d.views || d.hot || d.hotCode || d.viewCount),
    isVip: d.isVip || d.is_hot === 1 || d.is_vip === 1,
    platform: pf
  };
};

const fetchFromPlatform = async (pf: string, q: string, pg: number, pageSize: number = 20): Promise<Video[]> => {
  const apiBase = getPlatformApi(pf);
  const endpoint = q ? `${apiBase}/search` : `${apiBase}/home`;
  const lang = (pf === 'REELSHORT' || pf === 'DRAMABOX' || pf === 'SHORTSWAVE' || pf === 'REELIFE' || pf === 'STARSHORT' || pf === 'GOODSHORT') ? 'in' : 'id';
  const params = q ? { keyword: q, q, lang, page: pg, limit: pageSize } : { page: pg, limit: pageSize, lang };
  console.log(`[Frontend] Fetching ${pf} from ${endpoint}`, params);
  try {
    const res = await axios.get(endpoint, { params });
    if (res.data?.error) {
      console.error(`[API Error] Platform ${pf} gagal merespon: ${res.data.error}`);
    }
    console.log(`[Frontend] ${pf} response status:`, res.status);
    // DramaBox and ShortMax return dramas at root level, others use res.data.data
    const searchData = (res.data.dramas) ? res.data : (res.data.data || res.data);
    const items = Array.isArray(searchData?.dramas) ? searchData.dramas
      : searchData?.items || searchData?.list || (Array.isArray(searchData) ? searchData : []);

    if (items.length === 0 && !res.data?.error) {
      console.warn(`[API Kosong] Platform ${pf} tidak memiliki data.`);
    }

    console.log(`[Frontend] ${pf} raw items count:`, items.length);
    // Expose totalPages from backend response if available (e.g. StarShort)
    (fetchFromPlatform as any).__lastTotalPages = res.data?.totalPages || null;
    const responsePlatform = res.data.platform || pf;
    const mapped = items.map((d: any) => normalizeItem(d, d.platform || responsePlatform));
    console.log(`[Frontend] ${pf} mapped items count:`, mapped.length);
    return mapped;
  } catch (err: any) {
    console.error(`[Frontend] ${pf} fetch failed:`, err.message);
    return [];
  }
};

// Discover Screen
function DiscoverScreen({ onSelect, settings, adminId, persistentState, setPersistentState }: {
  onSelect: (v: Video) => void,
  settings: any,
  adminId: string | null,
  persistentState: any,
  setPersistentState: any
}) {
  const { query, platform, page, results, pageSize } = persistentState;
  const setQuery = (q: string) => setPersistentState((p: any) => ({ ...p, query: q }));
  const setPlatform = (pf: string) => setPersistentState((p: any) => ({ ...p, platform: pf }));
  const setPage = (pg: number | ((prev: number) => number)) => {
    if (typeof pg === 'function') {
      setPersistentState((p: any) => ({ ...p, page: pg(p.page) }));
    } else {
      setPersistentState((p: any) => ({ ...p, page: pg }));
    }
  };
  const setResults = (res: Video[] | ((prev: Video[]) => Video[])) => {
    if (typeof res === 'function') {
      setPersistentState((p: any) => ({ ...p, results: res(p.results) }));
    } else {
      setPersistentState((p: any) => ({ ...p, results: res }));
    }
  };
  const setPageSize = (sz: number) => setPersistentState((p: any) => ({ ...p, pageSize: sz }));

  // Default to 100 if not set, following user request for "no limits"
  useEffect(() => {
    if (!pageSize) setPageSize(100);
  }, []);

  const [loading, setLoading] = useState(false);
  const [totalPages, setTotalPages] = useState(99);
  const [hasMore, setHasMore] = useState(true);

  if (settings.hide_discover === 'on' && adminId !== ADMIN_ID) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center space-y-4">
        <Search size={64} className="text-[#A855F7] opacity-50 animate-pulse" />
        <h2 className="text-xl font-bold">Fitur Dimatikan</h2>
        <p className="text-sm text-gray-400">Fitur pencarian dan penemuan sedang dinonaktifkan sementara oleh admin.</p>
      </div>
    );
  }

  const platforms = ['ALL', 'BILITV', 'MOBOREELS', 'REELALA', 'REELSHORT', 'DRAMABOX', 'DRAMAPOPS', 'MELOLO', 'SHORTMAX', 'FLEXTV', 'DRAMABITE', 'IDRAMA', 'GOODSHORT', 'SHORTBOX', 'DRAMAWAVE', 'SHORTSWAVE', 'VELOLO', 'HAPPYSHORT', 'RAPIDTV', 'STARDUSTTV', 'REELIFE', 'STARSHORT', 'MICRODRAMA']
    .filter(p => {
      if (p === 'ALL') return true;
      const state = settings[`platform_${p.toLowerCase()}`];
      return state !== 'off'; // Default to ON if missing or not 'off'
    });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
  };

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setResults([]); // Clear old results to show loading state
      window.scrollTo({ top: 0, behavior: 'smooth' }); // Visual feedback
      try {
        if (platform === 'ALL') {
          const activePlatforms = ['BILITV', 'MOBOREELS', 'REELALA', 'REELSHORT', 'DRAMABOX', 'DRAMAPOPS', 'MELOLO', 'SHORTMAX', 'FLEXTV', 'DRAMABITE', 'IDRAMA', 'GOODSHORT', 'SHORTBOX', 'DRAMAWAVE', 'SHORTSWAVE', 'VELOLO', 'HAPPYSHORT', 'RAPIDTV', 'STARDUSTTV', 'REELIFE', 'STARSHORT', 'MICRODRAMA']
            .filter(pf => {
              return settings[`platform_${pf.toLowerCase()}`] !== 'off';
            });

          const settled = await Promise.allSettled(
            activePlatforms.map(pf => fetchFromPlatform(pf, query, page, pageSize))
          );
          if (cancelled) return;
          const arrays = settled
            .filter(r => r.status === 'fulfilled')
            .map(r => (r as PromiseFulfilledResult<Video[]>).value);
          const merged: Video[] = [];
          const maxLen = Math.max(...arrays.map(a => a.length), 0);
          // Interleave results for variety, following user request for "no limits"
          for (let i = 0; i < maxLen; i++) {
            for (const arr of arrays) { 
              if (arr[i]) merged.push(arr[i]); 
              if (merged.length >= pageSize * 5) break; // Allow a huge buffer for ALL mode
            }
            if (merged.length >= pageSize * 5) break;
          }
          if (!cancelled) {
            setResults(merged);
            setHasMore(merged.length >= pageSize);
            if (merged.length === 0) {
              console.warn('[Discover] All active platforms returned 0 results');
            }
          }
        } else {
          const items = await fetchFromPlatform(platform, query, page, pageSize);
          const backendTotal = (fetchFromPlatform as any).__lastTotalPages;
          if (!cancelled) {
            setResults(items);
            setHasMore(items.length >= pageSize);
            if (backendTotal) setTotalPages(backendTotal);
            else setTotalPages(items.length >= pageSize ? page + 4 : page);
          }
        }
      } catch (err) {
        console.error('Discover fetch failed:', err);
        if (!cancelled) { setResults([]); setHasMore(false); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const timer = setTimeout(run, query ? 500 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, platform, page, pageSize]);

  return (
    <div className="h-full flex flex-col pb-20">
      <header className="px-6 py-6 space-y-4">
        <h2 className="text-2xl font-bold">Discover</h2>

        {/* Search Bar */}
        <form onSubmit={handleSearch} className="relative">
          <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            placeholder="Search titles, actors, genres..."
            className="w-full pl-12 pr-4 py-3.5 glass rounded-2xl text-sm focus:outline-none focus:ring-2 ring-[#A855F7]/30 transition-all"
          />
        </form>

        {/* Platform Filter */}
        <div className="flex overflow-x-auto gap-2 py-2 px-1 -mx-1 hide-scrollbar" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
          {platforms.map(p => (
            <button
              key={p}
              onClick={() => { setPlatform(p); setPage(1); }}
              className={`whitespace-nowrap px-4 py-2 rounded-full text-[10px] font-bold transition-all border shrink-0 ${platform === p
                  ? 'bg-[#A855F7] border-[#A855F7] text-white shadow-[0_0_15px_rgba(168,85,247,0.4)]'
                  : 'bg-white/5 border-white/10 text-gray-400 hover:bg-white/10'
                }`}
            >
              {p}
            </button>
          ))}
        </div>
        {/* Page Size Selector */}
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className="font-semibold">Per halaman:</span>
          {[20, 50, 100, 200].map(sz => (
            <button
              key={sz}
              onClick={() => { setPageSize(sz); setPage(1); }}
              className={`px-3 py-1 rounded-full font-bold transition-all border ${pageSize === sz
                  ? 'bg-[#A855F7] border-[#A855F7] text-white shadow-[0_0_15px_rgba(168,85,247,0.4)]'
                  : 'glass border-white/10 text-gray-400 hover:bg-white/10'
                }`}
            >{sz === 200 ? 'MAX' : sz}</button>
          ))}
        </div>
      </header>

      {/* Results */}
      <div className="flex-1 overflow-y-auto px-6 space-y-6">
        {loading ? (
          <div className="h-40 flex items-center justify-center">
            <div className="w-8 h-8 border-3 border-[#A855F7] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : results.length > 0 ? (
          <div className="grid grid-cols-3 gap-3">
            {results.map((v: Video, i: number) => (
              <div key={`${v.platform}-${v.id}-${i}`} className="space-y-1 group" onClick={() => onSelect(v)}>
                <div className="relative aspect-[9/13] rounded-eight overflow-hidden glass border-white/5">
                  <img 
                    src={v.poster || 'https://images.placeholders.dev/?width=300&height=450&text=No+Poster&theme=dark'} 
                    onError={(e) => { (e.target as HTMLImageElement).src = 'https://images.placeholders.dev/?width=300&height=450&text=No+Poster&theme=dark'; }}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
                    alt={v.title} 
                  />
                  {v.isVip && (
                    <span className="absolute top-1 left-1 bg-[#A855F7] text-[8px] font-bold px-1.5 py-0.5 rounded shadow-lg">VIP</span>
                  )}
                  {v.platform && (
                    <span className="absolute top-1 right-1 bg-black/60 backdrop-blur-md text-[7px] font-bold px-1 py-0.5 rounded-full border border-white/5 uppercase">{v.platform}</span>
                  )}
                  <div className="absolute bottom-1 left-1 bg-black/60 backdrop-blur-md px-1.5 py-0.5 rounded text-[8px] font-bold flex items-center gap-1">
                    <span>EP {v.episodes}</span>
                    {v.likes && v.likes !== '0' && (
                      <>
                        <span className="opacity-50">|</span>
                        <Heart size={8} className="fill-current text-white" />
                        <span>{v.likes}</span>
                      </>
                    )}
                  </div>
                </div>
                <p className="text-[10px] font-semibold truncate leading-tight">{v.title}</p>
              </div>
            ))}
          </div>
        ) : query ? (
          <div className="h-40 flex flex-col items-center justify-center text-gray-500 space-y-2">
            <Search size={40} className="opacity-20" />
            <p className="text-sm">No results found for "{query}"</p>
          </div>
        ) : (
          <div className="h-40 flex flex-col items-center justify-center text-gray-500 space-y-2">
            <Activity size={40} className="opacity-20" />
            <p className="text-sm italic">Type to discover amazing shows</p>
          </div>
        )}

        {/* Pagination UI */}
        {results.length > 0 && (
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="flex items-center gap-1.5">
              {/* Prev */}
              <button
                onClick={() => { setPage((p: number) => Math.max(1, p - 1)); window.scrollTo(0, 0); }}
                disabled={page === 1}
                className="p-2 glass rounded-xl disabled:opacity-30 transition-all hover:bg-white/10"
              >
                <ChevronLeft size={16} />
              </button>

              {/* Page numbers — show a sliding window of 5 */}
              {(() => {
                const maxPage = Math.max(totalPages, page);
                const start = Math.max(1, Math.min(page - 2, maxPage - 4));
                const end = Math.min(maxPage, start + 4);
                return Array.from({ length: end - start + 1 }, (_, i) => start + i).map(p => (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`w-9 h-9 rounded-xl text-xs font-bold transition-all ${page === p
                        ? 'bg-[#A855F7] text-white shadow-[0_0_12px_rgba(168,85,247,0.5)]'
                        : 'glass text-gray-400 hover:bg-white/10'
                      }`}
                  >{p}</button>
                ));
              })()}

              {/* Next */}
              <button
                onClick={() => { if (hasMore) { setPage((p: number) => p + 1); window.scrollTo(0, 0); } }}
                disabled={!hasMore}
                className="p-2 glass rounded-xl disabled:opacity-30 transition-all hover:bg-white/10"
              >
                <ChevronLeft size={16} className="rotate-180" />
              </button>
            </div>
            <p className="text-[10px] text-gray-500">
              Halaman <span className="font-bold text-gray-300">{page}</span>
              {totalPages < 99 ? ` dari ${totalPages}` : ''}
              {' · '}{results.length} judul
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function AdultScreen({ onSelect, settings, adminId, persistentState, setPersistentState }: {
  onSelect: (v: Video) => void,
  settings: any,
  adminId: string | null,
  persistentState: any,
  setPersistentState: any
}) {
  const { query: search, page, results: items } = persistentState;
  const setSearch = (q: string) => setPersistentState((p: any) => ({ ...p, query: q }));
  const setPage = (pg: number | ((prev: number) => number)) => {
    if (typeof pg === 'function') {
      setPersistentState((p: any) => ({ ...p, page: pg(p.page) }));
    } else {
      setPersistentState((p: any) => ({ ...p, page: pg }));
    }
  };
  const setItems = (res: Video[] | ((prev: Video[]) => Video[])) => {
    if (typeof res === 'function') {
      setPersistentState((p: any) => ({ ...p, results: res(p.results) }));
    } else {
      setPersistentState((p: any) => ({ ...p, results: res }));
    }
  };

  const [loading, setLoading] = useState(false);
  const [activePlatform, setActivePlatform] = useState('ADULT');

  const loadData = async (pf: string, query: string, pg: number) => {
    setLoading(true);
    setItems([]); // Clear old items to show loading state
    window.scrollTo({ top: 0, behavior: 'smooth' }); // Visual feedback
    const data = await fetchFromPlatform(pf, query, pg, 100);
    setItems(data);
    setLoading(false);
  };

  useEffect(() => {
    setPage(1);
  }, [activePlatform, search]);

  useEffect(() => {
    loadData(activePlatform, search, page);
  }, [activePlatform, search, page]);

  if (settings.hide_discover === 'on' && adminId !== ADMIN_ID) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center space-y-4">
        <Activity size={64} className="text-[#A855F7] opacity-50 animate-pulse" />
        <h2 className="text-xl font-bold">Sedang Pemeliharaan</h2>
        <p className="text-sm text-gray-400">Menu ini sedang dalam pemeliharaan rutin. Silakan kembali lagi nanti.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="px-6 pt-8 pb-4 space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold tracking-tight text-red-500">Eksklusif 18+</h2>
          <div className="w-10 h-10 rounded-full glass flex items-center justify-center">
            <Flame size={20} className="text-red-500" />
          </div>
        </div>

        <div className="relative">
          <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            placeholder="Cari konten 18+..."
            className="w-full glass bg-white/5 py-4 pl-12 pr-4 rounded-2xl text-sm focus:ring-2 ring-red-500 outline-none transition-all border border-white/5"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 pb-24 scrollbar-hide">
        {loading && items.length === 0 ? (
          <div className="grid grid-cols-3 gap-3">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => (
              <div key={i} className="aspect-[3/4] glass rounded-xl animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {items.map((v: Video, i: number) => (
              <div
                key={`${v.platform}-${v.id}-${i}`}
                className="space-y-1.5 group cursor-pointer active:scale-95 transition-all"
                onClick={() => onSelect(v)}
              >
                <div className="relative aspect-[3/4] rounded-xl overflow-hidden glass border border-white/5 group-hover:border-red-500/30">
                  <img 
                    src={v.poster || 'https://images.placeholders.dev/?width=300&height=450&text=No+Poster&theme=dark'} 
                    onError={(e) => { (e.target as HTMLImageElement).src = 'https://images.placeholders.dev/?width=300&height=450&text=No+Poster&theme=dark'; }}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
                    alt={v.title} 
                  />
                  {v.isVip && (
                    <span className="absolute top-2 left-2 bg-red-500 text-[7px] font-bold px-1.5 py-0.5 rounded shadow-lg">18+</span>
                  )}
                </div>
                <h3 className="text-[10px] font-bold truncate px-1 group-hover:text-red-500 transition-colors">{v.title}</h3>
              </div>
            ))}
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4 opacity-50">
            <Activity size={48} className="text-gray-700" />
            <p className="text-sm font-medium">Belum ada konten tersedia.<br />API sedang dikonfigurasi.</p>
          </div>
        )}

        {items.length > 0 && (
          <div className="flex items-center justify-center space-x-2 py-8 pb-20">
            <button
              onClick={() => setPage((p: number) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-2 glass rounded-lg disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>

            {[...Array(5)].map((_, i) => {
              const p = Math.max(1, page - 2) + i;
              return (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`w-8 h-8 rounded-lg text-xs font-bold transition-all ${page === p ? 'bg-red-500 text-white' : 'glass text-gray-400'
                    }`}
                >
                  {p}
                </button>
              );
            })}

            <button
              onClick={() => setPage((p: number) => p + 1)}
              className="p-2 glass rounded-lg"
            >
              <ChevronLeft size={16} className="rotate-180" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AnimeScreen({ onSelect, settings, adminId, persistentState, setPersistentState }: {
  onSelect: (v: Video) => void,
  settings: any,
  adminId: string | null,
  persistentState: any,
  setPersistentState: any
}) {
  const { query: search, page, results: items } = persistentState;
  const setSearch = (q: string) => setPersistentState((p: any) => ({ ...p, query: q }));
  const setPage = (pg: number | ((prev: number) => number)) => {
    if (typeof pg === 'function') {
      setPersistentState((p: any) => ({ ...p, page: pg(p.page) }));
    } else {
      setPersistentState((p: any) => ({ ...p, page: pg }));
    }
  };
  const setItems = (res: Video[] | ((prev: Video[]) => Video[])) => {
    if (typeof res === 'function') {
      setPersistentState((p: any) => ({ ...p, results: res(p.results) }));
    } else {
      setPersistentState((p: any) => ({ ...p, results: res }));
    }
  };

  const [loading, setLoading] = useState(false);
  const [activePlatform, setActivePlatform] = useState('ANIME');

  const loadData = async (pf: string, query: string, pg: number, append = false) => {
    setLoading(true);
    if (!append) {
      setItems([]); // Clear old items
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    const data = await fetchFromPlatform(pf, query, pg, 100);
    setItems(prev => append ? [...prev, ...data] : data);
    setLoading(false);
  };

  useEffect(() => {
    setPage(1);
  }, [activePlatform, search]);

  useEffect(() => {
    loadData(activePlatform, search, page);
  }, [activePlatform, search, page]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="px-6 pt-8 pb-4 space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold tracking-tight text-[#A855F7]">Dunia Anime</h2>
          <div className="w-10 h-10 rounded-full glass flex items-center justify-center">
            <Tv size={20} className="text-[#A855F7]" />
          </div>
        </div>

        <div className="relative">
          <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            placeholder="Cari anime..."
            className="w-full glass bg-white/5 py-4 pl-12 pr-4 rounded-2xl text-sm focus:ring-2 ring-[#A855F7] outline-none transition-all border border-white/5"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 pb-24 scrollbar-hide">
        {loading && items.length === 0 ? (
          <div className="grid grid-cols-3 gap-3">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => (
              <div key={i} className="aspect-[3/4] glass rounded-xl animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {items.map((v: Video, i: number) => (
              <div
                key={`${v.platform}-${v.id}-${i}`}
                className="space-y-1.5 group cursor-pointer active:scale-95 transition-all"
                onClick={() => onSelect(v)}
              >
                <div className="relative aspect-[3/4] rounded-xl overflow-hidden glass border border-white/5 group-hover:border-[#A855F7]/30">
                  <img 
                    src={v.poster || 'https://images.placeholders.dev/?width=300&height=450&text=No+Poster&theme=dark'} 
                    onError={(e) => { (e.target as HTMLImageElement).src = 'https://images.placeholders.dev/?width=300&height=450&text=No+Poster&theme=dark'; }}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
                    alt={v.title} 
                  />
                  {v.isVip && (
                    <span className="absolute top-2 left-2 bg-[#A855F7] text-[7px] font-bold px-1.5 py-0.5 rounded shadow-lg">VIP</span>
                  )}
                  {v.platform && (
                    <span className="absolute top-2 right-2 bg-black/60 backdrop-blur-md text-[6px] font-bold px-1 py-0.5 rounded border border-white/10 uppercase">{v.platform === 'ANIME_CUBE' ? 'CUBE' : v.platform}</span>
                  )}
                </div>
                <h3 className="text-[10px] font-bold truncate px-1 group-hover:text-[#A855F7] transition-colors">{v.title}</h3>
              </div>
            ))}
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center space-y-4 opacity-50">
            <Tv size={48} className="text-gray-700" />
            <p className="text-sm font-medium">Belum ada anime tersedia.</p>
          </div>
        )}

        {items.length > 0 && (
          <div className="flex items-center justify-center space-x-2 py-8 pb-20">
            <button
              onClick={() => setPage((p: number) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-2 glass rounded-lg disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>

            {[...Array(5)].map((_, i) => {
              const p = Math.max(1, page - 2) + i;
              return (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`w-8 h-8 rounded-lg text-xs font-bold transition-all ${page === p ? 'bg-[#A855F7] text-white' : 'glass text-gray-400'
                    }`}
                >
                  {p}
                </button>
              );
            })}

            <button
              onClick={() => setPage((p: number) => p + 1)}
              className="p-2 glass rounded-lg"
            >
              <ChevronLeft size={16} className="rotate-180" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PlayerScreen({
  video, streamUrl, episodes, currentEpisode, subtitles, subtitleDiagnostics,
  onBack, onShowEpisodes, onNextEpisode, isSaved, onToggleSave,
  telegramId, onUpdateHistory, setLoading, onRefresh, settings, onUpdateSetting, setSubtitles
}: {
  video: Video | null,
  streamUrl: string | null,
  episodes: any[],
  currentEpisode: number | string,
  subtitles: any[],
  subtitleDiagnostics: any,
  onBack: () => void,
  onShowEpisodes: () => void,
  onNextEpisode: () => void,
  isSaved: boolean,
  onToggleSave: () => void,
  telegramId?: string | null,
  onUpdateHistory?: (displayNum: number) => void,
  setLoading?: (loading: boolean) => void,
  onRefresh?: (ep: number) => void,
  settings: any,
  onUpdateSetting: (key: string, val: string) => void,
  setSubtitles: (subs: any[]) => void
}) {
  const isAdmin = telegramId === ADMIN_ID;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState('00:00');
  const [duration, setDuration] = useState('00:00');
  const [activeSubtitle, setActiveSubtitle] = useState<any | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const [debugInfo, setDebugInfo] = useState<{ label: string, value: string }[]>([]);
  const [subtitleTrackUrl, setSubtitleTrackUrl] = useState<string | null>(null);
  const [loadedSubLang, setLoadedSubLang] = useState<string>('OFF');
  const [loadedSubType, setLoadedSubType] = useState<string>('None');
  const hideTimer = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);

  const playingIndex = episodes.length > 0 ? (episodes.findIndex(ep => (ep.id || ep.episNum || ep.number) === currentEpisode) + 1 || currentEpisode) : currentEpisode;

  // Reset player state when episode changes
  useEffect(() => {
    setProgress(0);
    setCurrentTime('00:00');
    setDuration('00:00');
    setShowOverlay(true);
    setIsPlaying(false);
    setActiveSubtitle(null);
    setVideoError(null);
    setShowDebugPanel(false);
    if (onUpdateHistory && playingIndex) {
      onUpdateHistory(Number(playingIndex));
    }
  }, [currentEpisode]);

  // Build debug info snapshot
  const buildDebugInfo = (extra: { label: string, value: string }[] = []) => {
    const vid = videoRef.current;

    const info: { label: string, value: string }[] = [
      { label: 'Platform', value: video?.platform || 'Unknown' },
      { label: 'Video ID', value: String(video?.id || '-') },
      { label: 'Episode', value: String(currentEpisode) },
      { label: 'Stream URL', value: streamUrl ? streamUrl.substring(0, 80) + '...' : 'NULL' },
      { label: 'Subtitle Type', value: loadedSubType },
      { label: 'Loaded Lang', value: loadedSubLang },
      { label: 'HLS Support', value: Hls.isSupported() ? 'Yes' : 'No' },
      { label: 'Native HLS', value: vid?.canPlayType('application/vnd.apple.mpegurl') || 'No' },
      { label: 'Ready State', value: vid ? ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'][vid.readyState] : '-' },
      { label: 'Network State', value: vid ? ['EMPTY', 'IDLE', 'LOADING', 'NO_SOURCE'][vid.networkState] : '-' },
      { label: 'Video Error', value: vid?.error ? `Code ${vid.error.code}: ${vid.error.message}` : 'None' },
      ...extra
    ];
    setDebugInfo(info);
  };

  // HLS Initialization
  useEffect(() => {
    if (!videoRef.current || !streamUrl) return;
    const video = videoRef.current;
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    if (streamUrl.includes('.m3u8')) {
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          xhrSetup: (xhr) => {
            xhr.withCredentials = false;
          }
        });
        hlsRef.current = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (video && document.contains(video)) {
            video.play().catch((e) => {
              if (e.name === 'AbortError') return; // Ignore expected interruptions
              setIsPlaying(false);
              const msg = `Play failed: ${e.message}`;
              setVideoError(msg);
              console.error('[Player]', msg);
            });
          }
        });
        hls.on(Hls.Events.ERROR, async (event, data) => {
          const errMsg = `[HLS] ${data.type} | ${data.details} | fatal: ${data.fatal}`;
          console.error(errMsg, data);
          if (data.fatal) {
            // Fetch proxy URL to get the real error details (JSON from our server)
            let proxyMessage = '';
            if (data.details === 'manifestParsingError' || data.details === 'manifestLoadError') {
              try {
                const resp = await fetch(streamUrl);
                if (!resp.ok) {
                  const body = await resp.json().catch(() => null);
                  const errorMsg = body?.message || body?.error || `HTTP ${resp.status}`;
                  proxyMessage = typeof errorMsg === 'object' ? JSON.stringify(errorMsg) : String(errorMsg);
                  console.error('[Player] Proxy returned error:', body);
                }
              } catch (fe) {
                proxyMessage = (fe as any).message;
              }
            }

            const errDisplay = proxyMessage
              ? `${data.details}: ${proxyMessage}`
              : `Playback failed: ${data.details}`;

            setVideoError(errDisplay);
            buildDebugInfo([
              { label: 'HLS Error Type', value: data.type },
              { label: 'HLS Error Detail', value: data.details },
              { label: 'Proxy Message', value: proxyMessage || 'N/A' },
              { label: 'Fatal', value: 'Yes' }
            ]);
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                hls.recoverMediaError();
                break;
              default:
                hls.destroy();
                hlsRef.current = null;
                break;
            }
          }
        });
        return () => { hls.destroy(); hlsRef.current = null; };
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = streamUrl;
        video.play().catch((e) => {
          setIsPlaying(false);
          setVideoError(`Native HLS failed: ${e.message}`);
        });
      } else {
        setVideoError('HLS not supported on this browser');
      }
    } else {
      video.src = streamUrl;
      video.play().catch((e) => {
        setIsPlaying(false);
        setVideoError(`Video play failed: ${e.message}`);
      });
    }
  }, [streamUrl]);

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  // Auto-hide overlay after 3 seconds when playing
  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setShowOverlay(false);
      }
    }, 3000);
  }, []);

  // When video starts playing, schedule hide
  const handlePlay = () => {
    setIsPlaying(true);
    scheduleHide();
    if (setLoading) setLoading(false);
  };

  const handlePause = () => {
    setIsPlaying(false);
    setShowOverlay(true);
  };

  // Update progress bar in real time
  const handleTimeUpdate = () => {
    const vid = videoRef.current;
    if (vid && vid.duration) {
      setProgress((vid.currentTime / vid.duration) * 100);
      setCurrentTime(formatTime(vid.currentTime));
      setDuration(formatTime(vid.duration));

      // Find active subtitle (fallback if track isn't rendering)
      if (subtitles && subtitles.length > 0) {
        const now = vid.currentTime;
        const sub = subtitles.find(s => now >= (s.from || s.start) && now <= (s.to || s.end));
        setActiveSubtitle(sub || null);
      } else {
        setActiveSubtitle(null);
      }
    }
  };

  // Convert cues to a WebVTT Blob URL for the native <track>
  useEffect(() => {
    if (!subtitles || subtitles.length === 0) {
      setSubtitleTrackUrl(null);
      setLoadedSubLang('OFF');
      setLoadedSubType('None');
      return;
    }

    const prefLang = (settings.default_subtitle_lang || 'id-ID').toLowerCase();
    const aliases = ['id-ID', 'id-id', 'id', 'in', 'ind', 'indonesia'];

    // If it's an array of tracks with URLs (unlikely from our standardized backend, but just in case)
    if (subtitles[0].url) {
      const target = subtitles.find(s => s.lang && aliases.includes(s.lang.toLowerCase())) || subtitles[0];

      let sType = 'External Track';
      const u = (target.url || '').toLowerCase();
      if (u.includes('.vtt')) sType = 'VTT (External)';
      else if (u.includes('.srt')) sType = 'SRT (External)';
      else if (u.includes('.ass')) sType = 'ASS (External)';

      setSubtitleTrackUrl(target.url);
      setLoadedSubLang(target.label || target.lang || prefLang.toUpperCase());
      setLoadedSubType(sType);
      return;
    }

    // Convert standardized cues [{from, to, content}] to VTT text
    let vtt = "WEBVTT\\n\\n";
    const formatVttTime = (sec: number) => {
      if (isNaN(sec)) return "00:00:00.000";
      const h = Math.floor(sec / 3600).toString().padStart(2, '0');
      const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
      const s = Math.floor(sec % 60).toString().padStart(2, '0');
      const ms = Math.floor((sec % 1) * 1000).toString().padStart(3, '0');
      return `${h}:${m}:${s}.${ms}`;
    };

    subtitles.forEach(sub => {
      const from = formatVttTime(Number(sub.from || sub.start || 0));
      const to = formatVttTime(Number(sub.to || sub.end || 0));
      const text = sub.content || sub.text || '';
      if (text) {
        vtt += `${from} --> ${to}\\n${text}\\n\\n`;
      }
    });

    const blob = new Blob([vtt], { type: 'text/vtt;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    setSubtitleTrackUrl(url);
    setLoadedSubLang(prefLang.toUpperCase());
    setLoadedSubType('VTT (Blob from JSON Cues)');

    return () => URL.revokeObjectURL(url);
  }, [subtitles, settings.default_subtitle_lang]);

  // Auto-next on video end
  const handleEnded = () => {
    setIsPlaying(false);
    const maxEp = episodes.length;
    if (Number(currentEpisode) < maxEp) {
      onNextEpisode();
    } else {
      setShowOverlay(true);
    }
  };

  // Tap screen to toggle overlay
  const handleScreenTap = () => {
    setShowOverlay(prev => !prev);
    if (!showOverlay) {
      scheduleHide();
    }
  };

  // Toggle play/pause
  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      vid.play();
    } else {
      vid.pause();
    }
  };

  // Seek on progress bar click
  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const vid = videoRef.current;
    if (!vid || !vid.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    vid.currentTime = pct * vid.duration;
  };

  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement, Event>) => {
    const vid = e.currentTarget;
    if (vid.videoWidth > vid.videoHeight) {
      setIsLandscape(true);
    } else {
      setIsLandscape(false);
    }
    if (setLoading) setLoading(false);
  };

  return (
    <div className={`h-full w-full relative bg-black ${isLandscape ? 'is-wide' : ''}`} onClick={handleScreenTap}>
      {/* Video Element - key forces remount on episode change */}
      {streamUrl ? (
        <video
          key={streamUrl}
          ref={videoRef}
          className={`absolute inset-0 w-full h-full ${isLandscape ? 'object-contain landscape' : 'object-cover portrait'}`}
          playsInline
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={handlePlay}
          onPause={handlePause}
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
          crossOrigin="anonymous"
          onError={(e) => {
            const vid = videoRef.current;
            const code = vid?.error?.code;
            const codeMap: any = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
            const msg = code ? `${codeMap[code] || 'UNKNOWN'} (code ${code})` : 'Unknown video error';
            setVideoError(msg);
            buildDebugInfo([{ label: 'Video Error Code', value: String(code || '?') }, { label: 'Error Msg', value: msg }]);
            console.error('[Player] Video error:', msg, vid?.error);
          }}
        >
          {subtitleTrackUrl && (
            <track
              kind="subtitles"
              src={subtitleTrackUrl}
              srcLang="id"
              label="Indonesia"
              default
            />
          )}
        </video>
      ) : (
        <img src={video?.poster || 'https://images.placeholders.dev/?width=300&height=450&text=No+Poster&theme=dark'} className="absolute inset-0 w-full h-full object-cover opacity-60" alt="background" />
      )}

      {/* Error Banner */}
      {videoError && !showDebugPanel && (
        <div className="absolute top-0 inset-x-0 z-[200] flex items-center justify-between px-4 py-3 bg-red-900/80 backdrop-blur-md border-b border-red-500/40">
          <div className="flex items-center space-x-2">
            <div className="w-2 h-2 rounded-full bg-red-400 animate-pulse flex-shrink-0" />
            <p className="text-[10px] text-red-200 font-mono font-bold leading-tight">{videoError}</p>
          </div>
          {isAdmin && (
            <button
              onClick={(e) => { e.stopPropagation(); buildDebugInfo(); setShowDebugPanel(true); }}
              className="ml-3 flex-shrink-0 px-2 py-1 bg-red-500/30 border border-red-400/40 rounded-md text-[9px] font-bold text-red-300 hover:bg-red-500/50 transition-colors"
            >
              Debug
            </button>
          )}
        </div>
      )}

      {/* Admin Debug Panel */}
      {isAdmin && showDebugPanel && (
        <div className="absolute inset-0 z-[300] bg-black/95 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-[#A855F7] tracking-tight">🛠 Player Debug</h3>
                <p className="text-[9px] text-gray-500 mt-0.5 font-mono">Admin Only — ID {ADMIN_ID}</p>
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={() => { if (onRefresh) onRefresh(Number(currentEpisode)); buildDebugInfo(); }}
                  className="px-3 py-1.5 bg-[#A855F7]/20 border border-[#A855F7]/30 rounded-lg text-[10px] font-bold text-[#A855F7]"
                >
                  Refresh
                </button>
                <button
                  onClick={() => setShowDebugPanel(false)}
                  className="px-3 py-1.5 glass border border-white/10 rounded-lg text-[10px] font-bold text-gray-300"
                >
                  Close
                </button>
              </div>
            </div>

            {videoError && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                <p className="text-[9px] text-red-400 font-mono font-bold uppercase tracking-widest mb-1">⚠ Error Detected</p>
                <p className="text-[11px] text-red-300 font-mono break-all">{videoError}</p>
              </div>
            )}

            <div className="space-y-2">
              {debugInfo.map((item, i) => (
                <div key={i} className="flex justify-between items-start p-2.5 bg-white/[0.03] rounded-lg border border-white/5">
                  <span className="text-[9px] text-gray-500 font-bold uppercase tracking-widest flex-shrink-0 mr-3">{item.label}</span>
                  <span className="text-[10px] text-gray-300 font-mono text-right break-all">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeSubtitle && (
        <div className="absolute left-0 right-0 z-[100] flex flex-col items-center justify-center pointer-events-none" style={{ top: isLandscape ? '80%' : '85%', transform: 'translateY(-50%)' }}>
          <div
            className="text-center px-4 py-1 max-w-[90%]"
            style={{
              fontFamily: '"Standard Symbols PS", sans-serif',
              fontSize: isLandscape ? '18px' : '14px',
              fontWeight: 'bold',
              color: 'white',
              textShadow: '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 2px 4px rgba(0,0,0,0.8)',
              lineHeight: '1.4',
            }}
          >
            {activeSubtitle.content || activeSubtitle.text}
          </div>
        </div>
      )}

      {/* Overlay - auto-hide when playing */}
      <div className={`absolute inset-0 z-40 transition-opacity duration-500 ${showOverlay && !showDebugPanel ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        {/* Back Button */}
        <button onClick={(e) => { e.stopPropagation(); onBack(); }} className="absolute top-6 left-6 z-50 p-2 glass rounded-full">
          <ChevronLeft size={24} />
        </button>

        {/* Admin Debug Button — below Back button, away from all controls */}
        {isAdmin && (
          <button
            onClick={(e) => { e.stopPropagation(); buildDebugInfo(); setShowDebugPanel(true); }}
            className="absolute top-20 left-4 z-50 flex items-center space-x-1.5 px-2.5 py-1 bg-black/50 border border-[#A855F7]/50 backdrop-blur-md rounded-full"
            title="Admin Debug"
          >
            <Activity size={11} className="text-[#A855F7]" />
            <span className="text-[8px] font-bold text-[#A855F7] uppercase tracking-wider">Debug</span>
          </button>
        )}

        {/* Episode Indicator */}
        <div className="absolute top-6 right-6 z-50 glass px-3 py-1.5 rounded-full">
          <span className="text-xs font-bold text-[#A855F7]">
            EP {playingIndex}
          </span>
        </div>

        {/* Right Side Interaction Bar */}
        <div className="absolute right-4 bottom-56 flex flex-col items-center space-y-6 z-50">
          <div className="relative">
            <div className="w-12 h-12 rounded-full border-2 border-[#A855F7] overflow-hidden p-0.5">
              <img src="https://i.pravatar.cc/100" className="w-full h-full rounded-full" alt="avatar" />
            </div>
          </div>
          <div className="flex flex-col items-center cursor-pointer" onClick={(e) => { e.stopPropagation(); onToggleSave(); }}>
            <Bookmark size={28} className={isSaved ? "text-[#A855F7]" : "text-gray-200"} fill={isSaved ? "#A855F7" : "none"} />
            <span className="text-xs font-bold mt-1">My List</span>
          </div>
          <div className="flex flex-col items-center">
            <MessageCircle size={28} className="text-gray-200" />
            <span className="text-xs font-bold mt-1">4.2K</span>
          </div>
          <div className="flex flex-col items-center cursor-pointer" onClick={(e) => {
            e.stopPropagation();
            const langs = ['in', 'en', 'ch', 'th', 'vi'];
            const current = (settings.default_subtitle_lang || 'in').toLowerCase();
            const next = langs[(langs.indexOf(current) + 1) % langs.length];
            onUpdateSetting('default_subtitle_lang', next);
            // Re-fetch subtitles immediately
            if (video && episodes[Number(currentEpisode) - 1]) {
              const epItem = episodes[Number(currentEpisode) - 1];
              const epId = (video.platform === 'BILITV' || video.platform === 'SHORTSWAVE' || video.platform === 'DRAMAPOPS' || video.platform === 'STARDUSTTV' || video.platform === 'REELIFE' || video.platform === 'STARSHORT' || video.platform === 'MICRODRAMA')
                ? (epItem.id || currentEpisode)
                : currentEpisode;
              axios.get(`${SERVER_BASE}/${(video.platform || 'BILITV').toLowerCase()}/subtitle/${video.id}/${epId}`, { params: { lang: next } })
                .then(res => setSubtitles(res.data.data?.list || res.data.data || []))
                .catch(() => setSubtitles([]));
            }
          }}>
            <div className="w-10 h-10 glass rounded-full flex items-center justify-center border border-white/20 overflow-hidden">
              <span className="text-[11px] font-bold uppercase" style={{ textShadow: '0 2px 4px rgba(0,0,0,0.5)' }}>
                {loadedSubLang.substring(0, 3)}
              </span>
            </div>
            <span className="text-[10px] font-bold mt-1 uppercase opacity-80 tracking-tighter shadow-black drop-shadow-md">
              {(settings.default_subtitle_lang || 'in').toUpperCase()} SUB
            </span>
          </div>
          <div className="flex flex-col items-center">
            <Share2 size={28} className="text-gray-200" />
            <span className="text-xs font-bold mt-1">Share</span>
          </div>
        </div>

        {/* Central Play/Pause - pointer-events-none so it doesn't block bottom buttons */}
        <div className="absolute inset-0 flex items-center justify-center z-30 pointer-events-none">
          <div className="flex items-center space-x-12 pointer-events-auto">
            <button onClick={(e) => { e.stopPropagation(); const v = videoRef.current; if (v) v.currentTime = Math.max(0, v.currentTime - 10); }} className="p-3 bg-white/10 backdrop-blur-xl rounded-full">
              <SkipBack size={24} className="text-white/70" />
            </button>
            <button onClick={togglePlay} className="p-6 bg-white/10 backdrop-blur-xl rounded-full border border-white/20">
              {isPlaying ? <Pause size={32} fill="white" /> : <Play size={32} fill="white" />}
            </button>
            <button onClick={(e) => { e.stopPropagation(); const v = videoRef.current; if (v) v.currentTime = Math.min(v.duration, v.currentTime + 10); }} className="p-3 bg-white/10 backdrop-blur-xl rounded-full">
              <SkipForward size={24} className="text-white/70" />
            </button>
          </div>
        </div>

        {/* Bottom Overlay - z-50 to sit above central controls */}
        <div className="absolute inset-x-0 bottom-0 teamdl-gradient p-6 pb-8 z-50">
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-xl font-bold">{video?.title}</h2>
              <p className="text-xs text-gray-300 line-clamp-1 leading-relaxed opacity-80">
                Episode {playingIndex} of {episodes.length || video?.episodes}
              </p>
            </div>

            <div className="flex items-center space-x-4">
              <button onClick={(e) => { e.stopPropagation(); onShowEpisodes(); }} className="flex-1 glass py-3 rounded-eight font-bold flex items-center justify-center space-x-2 active:scale-95 transition-transform">
                <List size={18} />
                <span>Episodes</span>
              </button>
              <button onClick={(e) => { e.stopPropagation(); onNextEpisode(); }} className={`flex-1 bg-[#A855F7] py-3 rounded-eight font-bold flex items-center justify-center space-x-2 active:scale-95 transition-transform ${Number(currentEpisode) >= episodes.length ? 'opacity-40' : ''}`}>
                <SkipForward size={18} fill="white" />
                <span>Next Ep</span>
              </button>
            </div>

            {/* Real Progress Bar */}
            <div className="space-y-2">
              <div className="w-full bg-white/10 h-1.5 rounded-full overflow-hidden cursor-pointer" onClick={handleSeek}>
                <div className="bg-[#A855F7] h-full shadow-[0_0_10px_rgba(168,85,247,0.5)] transition-all duration-200" style={{ width: `${progress}%` }} />
              </div>
              <div className="flex justify-between text-[10px] text-gray-400 font-bold tracking-widest">
                <span>{currentTime}</span>
                <span>{duration}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function EpisodeModal({ video, episodes, currentEpisode, isVip, onClose, onSelectEpisode }: { video: Video | null, episodes: any[], currentEpisode: string | number, isVip: boolean, onClose: () => void, onSelectEpisode: (ep: string | number) => void }) {
  const FREE_LIMIT = 5;
  const totalEps = episodes.length || (video?.episodes ?? 0);
  const displayEps = episodes.length > 0
    ? episodes
    : Array.from({ length: totalEps }, (_, i) => ({ id: i + 1, episNum: i + 1, title: `EP ${i + 1}` }));
  const playingIndex = displayEps.findIndex(ep => (ep.id || ep.episNum || ep.number) === currentEpisode) + 1 || currentEpisode;

  return (
    <div className="absolute inset-0 z-[100] flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="glass rounded-t-3xl max-h-[75%] z-10 flex flex-col overflow-hidden border-t border-white/10">
        <div className="p-6 pb-3">
          <div className="w-12 h-1.5 bg-white/20 rounded-full mx-auto mb-5" />
          <div className="flex justify-between items-start">
            <div>
              <h3 className="text-lg font-bold mb-1">Episodes</h3>
              <p className="text-xs text-gray-400 truncate max-w-[200px]">{video?.title}</p>
            </div>
            <div className={`px-3 py-1 rounded-full text-[10px] font-bold ${isVip
                ? 'bg-[#A855F7]/20 text-[#A855F7] border border-[#A855F7]/40'
                : 'bg-white/5 text-gray-400 border border-white/10'
              }`}>
              {isVip ? '👑 VIP Active' : '🔒 Free User'}
            </div>
          </div>
          <p className="text-[10px] text-[#A855F7] font-bold mt-3">▶ Now Playing: EP {playingIndex}</p>
        </div>

        {/* VIP Promo Banner for non-VIP */}
        {!isVip && (
          <div className="mx-6 mb-4 p-3 rounded-xl bg-gradient-to-r from-[#A855F7]/20 to-purple-900/20 border border-[#A855F7]/30">
            <div className="flex items-center space-x-3">
              <div className="text-2xl">👑</div>
              <div className="flex-1">
                <p className="text-xs font-bold">Upgrade ke VIP</p>
                <p className="text-[10px] text-gray-400">Unlock semua episode tanpa batas</p>
              </div>
              <button className="bg-[#A855F7] px-3 py-1.5 rounded-lg text-[10px] font-bold active:scale-95 transition-transform">
                Beli VIP
              </button>
            </div>
          </div>
        )}

        {/* Episode Grid - 5 columns */}
        <div className="flex-1 overflow-y-auto px-6 pb-10">
          <div className="grid grid-cols-5 gap-2">
            {displayEps.map((epItem, idx) => {
              const ep = epItem || {};
              const num = ep.id || ep.episNum || ep.number || idx + 1;
              const displayNum = idx + 1;
              const isCurrent = String(num) === String(currentEpisode);
              const isLocked = !isVip && (ep.isVip || idx >= FREE_LIMIT);

              return (
                <button
                  key={`${num}-${idx}`}
                  onClick={() => {
                    if (!isLocked) onSelectEpisode(num);
                  }}
                  className={`relative aspect-square rounded-xl flex flex-col items-center justify-center transition-all active:scale-90 ${isCurrent
                      ? 'bg-[#A855F7] shadow-[0_0_15px_rgba(168,85,247,0.4)]'
                      : isLocked
                        ? 'bg-white/[0.03] border border-white/[0.06] opacity-50'
                        : 'bg-white/5 border border-white/10 hover:bg-white/10'
                    }`}
                >
                  {isLocked && (
                    <Lock size={12} className="text-gray-500 mb-0.5" />
                  )}
                  <span className={`text-sm font-bold ${isCurrent ? 'text-white' : isLocked ? 'text-gray-600' : 'text-gray-200'
                    }`}>
                    {displayNum}
                  </span>
                  {isCurrent && (
                    <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-400 rounded-full border-2 border-[#131315] animate-pulse" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center justify-center space-x-6 mt-6 pt-4 border-t border-white/5">
            <div className="flex items-center space-x-2">
              <div className="w-3 h-3 rounded bg-[#A855F7]" />
              <span className="text-[10px] text-gray-400">Playing</span>
            </div>
            <div className="flex items-center space-x-2">
              <div className="w-3 h-3 rounded bg-white/10 border border-white/20" />
              <span className="text-[10px] text-gray-400">Free</span>
            </div>
            {!isVip && (
              <div className="flex items-center space-x-2">
                <Lock size={10} className="text-gray-500" />
                <span className="text-[10px] text-gray-400">VIP Only</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileScreen({ user, isVip, vipUntil, telegramId, onSettings, onMyList, onBack, onLogout, onVipUpdate }: { user: FireUser | null, isVip: boolean, vipUntil: string | null, telegramId: string | null, onSettings: () => void, onMyList: () => void, onBack: () => void, onLogout: () => void, onVipUpdate?: (v: boolean, u: string | null, tg: string) => void }) {
  const [editTgId, setEditTgId] = useState(telegramId || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const saveTelegramId = async () => {
    if (!user || !editTgId.trim()) return;
    setSaving(true);
    try {
      await setDoc(doc(fireDb, 'users', user.uid), { telegramId: editTgId.trim() }, { merge: true });
      const vipRes = await axios.get(`http://127.0.0.1:5001/api/vip-check/${editTgId.trim()}`);
      if (onVipUpdate) {
        onVipUpdate(vipRes.data.isVip, vipRes.data.vipUntil, editTgId.trim());
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('Failed to save TG ID', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto pb-20">
      <div className="p-8 flex flex-col items-center text-center space-y-4">
        <div className="relative">
          <div className="w-24 h-24 rounded-full border-4 border-[#A855F7] p-1 shadow-[0_0_30px_rgba(168,85,247,0.3)]">
            <div className="w-full h-full rounded-full bg-gradient-to-br from-[#A855F7] to-purple-700 flex items-center justify-center">
              <User size={40} className="text-white" />
            </div>
          </div>
          {isVip && (
            <div className="absolute -top-1 -right-1 bg-[#A855F7] rounded-full p-1.5 border-4 border-[#131315]">
              <Crown size={12} className="text-white" />
            </div>
          )}
        </div>
        <div>
          <h2 className="text-xl font-bold">{user?.email?.split('@')[0] || 'User'}</h2>
          <p className="text-xs text-gray-400 mt-0.5">{user?.email}</p>
          <div className={`inline-flex items-center space-x-1.5 mt-2 px-3 py-1 rounded-full text-[10px] font-bold ${isVip ? 'bg-[#A855F7]/20 text-[#A855F7] border border-[#A855F7]/40' : 'bg-white/5 text-gray-400 border border-white/10'
            }`}>
            {isVip ? <><Crown size={10} /><span>VIP Active</span></> : <><Lock size={10} /><span>Free User</span></>}
          </div>
          {isVip && vipUntil && (
            <p className="text-[10px] text-gray-500 mt-1">VIP sampai: {new Date(vipUntil).toLocaleDateString('id-ID')}</p>
          )}
        </div>
      </div>

      <div className="px-6 space-y-6">
        {/* Telegram ID Linking */}
        <section className="glass rounded-2xl p-4 border border-white/5 space-y-3">
          <div className="flex items-center space-x-2">
            <ExternalLink size={16} className="text-[#A855F7]" />
            <h3 className="text-sm font-bold">Hubungkan Telegram</h3>
          </div>
          <p className="text-[10px] text-gray-500">Masukkan Telegram ID untuk sinkronisasi status VIP dari bot. <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" className="text-[#A855F7] hover:underline">Klik di sini untuk cek ID Anda</a></p>
          <div className="flex space-x-2">
            <input
              type="text"
              value={editTgId}
              onChange={(e) => setEditTgId(e.target.value)}
              placeholder="Contoh: 123456789"
              className="flex-1 px-4 py-2.5 glass rounded-xl text-xs bg-white/5 border border-white/10 focus:border-[#A855F7]/50 focus:outline-none"
            />
            <button
              onClick={saveTelegramId}
              disabled={saving}
              className="px-4 py-2.5 bg-[#A855F7] rounded-xl text-xs font-bold active:scale-95 disabled:opacity-50"
            >
              {saved ? <Check size={14} /> : saving ? '...' : 'Simpan'}
            </button>
          </div>
          {telegramId && (
            <div className="flex items-center space-x-2 text-[10px] text-green-400">
              <Check size={12} />
              <span>Terhubung: {telegramId}</span>
            </div>
          )}
        </section>

        {/* VIP Promo (non-VIP only) */}
        {!isVip && (
          <section className="rounded-2xl p-4 bg-gradient-to-br from-[#A855F7]/20 to-purple-900/10 border border-[#A855F7]/30 space-y-3">
            <div className="flex items-center space-x-3">
              <div className="text-2xl">👑</div>
              <div className="flex-1">
                <p className="text-sm font-bold">Dapatkan VIP</p>
                <p className="text-[10px] text-gray-400">Unlock semua episode tanpa batas</p>
              </div>
            </div>
            <button
              onClick={() => window.open(`https://t.me/${BOT_USERNAME}?start=buyvip`, '_blank')}
              className="w-full py-3 bg-[#A855F7] rounded-xl text-xs font-bold flex items-center justify-center space-x-2 active:scale-95"
            >
              <ExternalLink size={14} />
              <span>Beli VIP via @{BOT_USERNAME}</span>
            </button>
          </section>
        )}

        <section className="space-y-2">
          <ProfileLink icon={<Bookmark size={20} />} label="My List" onClick={onMyList} />
          <ProfileLink icon={<Wallet size={20} />} label="Wallet & VIP" />
          <ProfileLink icon={<SettingsIcon size={20} />} label="App Settings" onClick={onSettings} />
          <div className="pt-4">
            <button
              onClick={onLogout}
              className="w-full py-4 text-red-500 font-bold text-sm hover:bg-red-500/10 rounded-eight transition-colors flex items-center justify-center space-x-2"
            >
              <LogOut size={18} />
              <span>Keluar</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function ProfileLink({ icon, label, onClick }: { icon: any, label: string, onClick?: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center justify-between p-4 glass rounded-xl hover:bg-white/10 transition-all active:scale-[0.98]">
      <div className="flex items-center space-x-4">
        <div className="text-gray-400">{icon}</div>
        <span className="font-bold text-sm">{label}</span>
      </div>
      <ChevronLeft size={18} className="rotate-180 text-gray-600" />
    </button>
  );
}

function SettingsScreen({ onBack, quality, onQualityChange, dataSettings, onDataSettingsChange }: { onBack: () => void, quality: string, onQualityChange: (q: string) => void, dataSettings: string, onDataSettingsChange: (s: string) => void }) {
  return (
    <div className="h-full overflow-y-auto pb-20">
      <header className="px-6 py-8 flex items-center space-x-4">
        <button onClick={onBack} className="p-2 glass rounded-full">
          <ChevronLeft size={20} />
        </button>
        <h2 className="text-2xl font-bold">Settings</h2>
      </header>

      <div className="px-6 space-y-10">
        <section className="space-y-6">
          <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest">Video Quality</h3>

          <div className="space-y-6">
            <div>
              <p className="text-sm font-bold mb-4 text-gray-300">Cellular Data Settings</p>
              <div className="grid grid-cols-1 gap-2">
                <QualityOption
                  label="Auto (Recommended)"
                  active={dataSettings === 'Auto'}
                  onClick={() => onDataSettingsChange('Auto')}
                />
                <QualityOption
                  label="Higher Picture Quality"
                  active={dataSettings === 'High'}
                  onClick={() => onDataSettingsChange('High')}
                />
                <QualityOption
                  label="Data Saver"
                  active={dataSettings === 'Low'}
                  onClick={() => onDataSettingsChange('Low')}
                />
              </div>
            </div>

            <div>
              <p className="text-sm font-bold mb-4 text-gray-300">Specific Resolution Limit</p>
              <div className="grid grid-cols-3 gap-3">
                {['1080p', '720p', '480p', 'Auto'].map(res => (
                  <button
                    key={res}
                    onClick={() => onQualityChange(res)}
                    className={`py-3 rounded-eight text-xs font-bold transition-all ${quality === res ? 'bg-[#A855F7] border-[#A855F7]' : 'glass border-white/5'}`}
                  >
                    {res}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function QualityOption({ label, active, onClick }: { label: string, active?: boolean, onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className={`p-4 rounded-xl flex items-center justify-between transition-all cursor-pointer ${active ? 'bg-[#A855F7]/10 border border-[#A855F7]/50' : 'glass border-white/5'}`}
    >
      <span className={`text-sm font-bold ${active ? 'text-white' : 'text-gray-400'}`}>{label}</span>
      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${active ? 'border-[#A855F7] bg-[#A855F7]' : 'border-gray-600'}`}>
        {active && <Check size={12} className="text-white" />}
      </div>
    </div>
  );
}

function MyListScreen({ myList, watchHistory, onSelect, onBack }: { myList: Video[], watchHistory: Record<string, number>, onSelect: (v: Video) => void, onBack: () => void }) {
  return (
    <div className="h-full overflow-y-auto pb-20">
      <header className="px-6 py-6 flex items-center space-x-4">
        <button onClick={onBack} className="p-2 glass rounded-full">
          <ChevronLeft size={24} />
        </button>
        <h2 className="text-xl font-bold">My List</h2>
      </header>
      <div className="px-6 grid grid-cols-3 gap-3">
        {myList.map((v, i) => (
          <div key={i} onClick={() => onSelect(v)} className="cursor-pointer space-y-1.5 group">
            <div className="relative aspect-[3/4] rounded-lg overflow-hidden glass border border-white/10 group-hover:border-[#A855F7]/50 transition-colors">
              <img src={v.poster || 'https://media.publit.io/file/No-Poster.png'} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" alt={v.title} />
              {v.platform && (
                <div className="absolute top-1.5 right-1.5 bg-black/60 backdrop-blur-md px-1 py-0.5 rounded text-[7px] font-bold uppercase tracking-widest border border-white/10">
                  {v.platform}
                </div>
              )}
            </div>
            <div>
              <h3 className="font-bold text-[10px] truncate group-hover:text-[#A855F7] transition-colors">{v.title}</h3>
              {watchHistory[v.id] ? (
                <div className="flex items-center space-x-1 mt-0.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  <p className="text-[8px] text-[#A855F7] font-bold">Ep {watchHistory[v.id]} / {v.episodes}</p>
                </div>
              ) : (
                <p className="text-[8px] text-gray-500 mt-0.5">{v.episodes} Episodes</p>
              )}
            </div>
          </div>
        ))}
        {myList.length === 0 && (
          <div className="col-span-3 text-center py-20 text-gray-500 text-xs">
            Belum ada video yang disimpan
          </div>
        )}
      </div>
    </div>
  );
}
