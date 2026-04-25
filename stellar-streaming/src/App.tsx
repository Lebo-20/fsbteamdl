import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { auth, db as fireDb } from './firebase';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  onAuthStateChanged, 
  signOut,
  User as FireUser 
} from 'firebase/auth';
import { doc, setDoc, getDoc } from 'firebase/firestore';
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
  ExternalLink
} from 'lucide-react';

// Types
type Screen = 'LOGIN' | 'HOME' | 'PLAYER' | 'PROFILE' | 'SETTINGS';

interface Video {
  id: number;
  title: string;
  poster: string;
  episodes: number;
  likes: string;
  isVip?: boolean;
}

const DEMO_VIDEOS: Video[] = [
  { id: 1, title: "The CEO's Secret Life", poster: "https://images.unsplash.com/photo-1536440136628-849c177e76a1?q=80&w=1000", episodes: 24, likes: "1.2M", isVip: true },
  { id: 2, title: "Romance in Seoul", poster: "https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?q=80&w=1000", episodes: 16, likes: "850K" },
  { id: 3, title: "Cyberpunk 2077: Edgerunners", poster: "https://images.unsplash.com/photo-1614728263952-84ea256f9679?q=80&w=1000", episodes: 10, likes: "2.4M", isVip: true },
  { id: 4, title: "Ancient Love Song", poster: "https://images.unsplash.com/photo-1533929736458-ca588d08c8be?q=80&w=1000", episodes: 30, likes: "400K" },
];

const API_BASE = 'http://localhost:5000/api/bilitv';
const BOT_USERNAME = 'ShortTeamDl_bot';

export default function App() {
  const [screen, setScreen] = useState<Screen>('LOGIN');
  const [fireUser, setFireUser] = useState<FireUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [telegramId, setTelegramId] = useState<string | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<any | null>(null);
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [currentStream, setCurrentStream] = useState<string | null>(null);
  const [currentEpisode, setCurrentEpisode] = useState(1);
  const [showEpisodes, setShowEpisodes] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isVip, setIsVip] = useState(false);
  const [vipUntil, setVipUntil] = useState<string | null>(null);
  const [showVipPopup, setShowVipPopup] = useState(false);

  // Firebase Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFireUser(user);
      if (user) {
        // Load user profile from Firestore
        try {
          const userDoc = await getDoc(doc(fireDb, 'users', user.uid));
          if (userDoc.exists()) {
            const data = userDoc.data();
            setTelegramId(data.telegramId || null);
            // Check VIP from bot database
            if (data.telegramId) {
              const vipRes = await axios.get(`${API_BASE}/vip-check/${data.telegramId}`);
              setIsVip(vipRes.data.isVip);
              setVipUntil(vipRes.data.vipUntil);
            }
          }
        } catch (e) {
          console.error('Failed to load user profile', e);
        }
        setScreen('HOME');
        fetchHome();
      } else {
        setScreen('LOGIN');
      }
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

  const handleLogout = async () => {
    await signOut(auth);
    setFireUser(null);
    setTelegramId(null);
    setIsVip(false);
    setScreen('LOGIN');
  };

  const fetchHome = async () => {
    try {
      const res = await axios.get(`${API_BASE}/home`, { params: { lang: 'id' } });
      const mapped = res.data.data.dramas.map((d: any) => ({
        id: d.id,
        title: d.title,
        poster: d.cover_img,
        episodes: d.total_num,
        likes: d.click_num > 1000 ? (d.click_num / 1000).toFixed(1) + 'K' : d.click_num,
        isVip: d.is_hot === 1
      }));
      setVideos(mapped);
    } catch (err) {
      console.error('Fetch home failed', err);
    }
  };

  const handleSelectVideo = async (video: Video) => {
    setLoading(true);
    setSelectedVideo(video);
    setCurrentEpisode(1);
    setScreen('PLAYER');
    try {
      const resE = await axios.get(`${API_BASE}/episodes/${video.id}`);
      const epList = resE.data.data?.list || resE.data.data || [];
      setEpisodes(epList);
      
      // Auto play first episode
      const resS = await axios.get(`${API_BASE}/stream/${video.id}/1`, { params: { lang: 'id' } });
      setCurrentStream(resS.data.data.url);
    } catch (err) {
      console.error('Fetch detail failed', err);
    } finally {
      setLoading(false);
    }
  };

  const playEpisode = async (epNum: number) => {
    if (!selectedVideo) return;
    // VIP check: episodes > 5 require VIP
    if (!isVip && epNum > 5) {
      setShowVipPopup(true);
      return;
    }
    setLoading(true);
    try {
      const resS = await axios.get(`${API_BASE}/stream/${selectedVideo.id}/${epNum}`, { params: { lang: 'id' } });
      setCurrentStream(resS.data.data.url);
      setCurrentEpisode(epNum);
    } catch (err) {
      console.error('Failed to load episode', err);
    } finally {
      setLoading(false);
    }
  };

  const handleNextEpisode = () => {
    const maxEp = episodes.length;
    if (currentEpisode < maxEp) {
      playEpisode(currentEpisode + 1);
    }
  };

  const renderScreen = () => {
    switch (screen) {
      case 'LOGIN':
        return <LoginScreen onSuccess={() => {}} />;
      case 'HOME':
        return <HomeScreen videos={videos} onSelect={handleSelectVideo} />;
      case 'PLAYER':
        return (
          <PlayerScreen 
            video={selectedVideo} 
            streamUrl={currentStream}
            episodes={episodes}
            currentEpisode={currentEpisode}
            onBack={() => setScreen('HOME')} 
            onShowEpisodes={() => setShowEpisodes(true)}
            onNextEpisode={handleNextEpisode}
          />
        );
      case 'PROFILE':
        return <ProfileScreen user={fireUser} isVip={isVip} vipUntil={vipUntil} telegramId={telegramId} onSettings={() => setScreen('SETTINGS')} onBack={() => setScreen('HOME')} onLogout={handleLogout} />;
      case 'SETTINGS':
        return <SettingsScreen onBack={() => setScreen('PROFILE')} />;
    }
  };

  if (authLoading) {
    return (
      <div className="h-screen w-screen bg-[#131315] flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-[#A855F7] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-[#131315] text-white overflow-hidden relative">
      {renderScreen()}

      {/* Bottom Navigation (Only on Home/Profile) */}
      {(screen === 'HOME' || screen === 'PROFILE') && (
        <nav className="absolute bottom-0 left-0 right-0 h-16 glass flex items-center justify-around px-4 pb-2 z-50">
          <NavItem icon={<Home size={24} />} label="Home" active={screen === 'HOME'} onClick={() => setScreen('HOME')} />
          <NavItem icon={<Search size={24} />} label="Discover" active={false} onClick={() => {}} />
          <NavItem icon={<User size={24} />} label="Profile" active={screen === 'PROFILE'} onClick={() => setScreen('PROFILE')} />
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
            if (!isVip && ep > 5) {
              setShowVipPopup(true);
            } else {
              playEpisode(ep);
              setShowEpisodes(false);
            }
          }}
        />
      )}

      {/* VIP Purchase Popup */}
      {showVipPopup && (
        <VipPopup onClose={() => setShowVipPopup(false)} />
      )}

      {loading && (
        <div className="absolute inset-0 z-[200] bg-black/40 backdrop-blur-md flex items-center justify-center">
          <div className="w-12 h-12 border-4 border-[#A855F7] border-t-transparent rounded-full animate-spin" />
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
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        // Save user profile to Firestore
        await setDoc(doc(fireDb, 'users', cred.user.uid), {
          email,
          telegramId: tgId || null,
          createdAt: new Date().toISOString(),
          isVip: false
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
          <h1 className="text-4xl font-black bg-gradient-to-r from-[#A855F7] to-purple-400 bg-clip-text text-transparent">STELLAR</h1>
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

function NavItem({ icon, label, active, onClick }: { icon: any, label: string, active: boolean, onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex flex-col items-center justify-center space-y-1 transition-all ${active ? 'text-[#A855F7]' : 'text-gray-400'}`}>
      {icon}
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}

function HomeScreen({ videos, onSelect }: { videos: Video[], onSelect: (v: Video) => void }) {
  const featured = videos[0] || DEMO_VIDEOS[0];
  return (
    <div className="h-full overflow-y-auto pb-20">
      {/* Top Bar */}
      <header className="px-6 py-4 flex justify-between items-center">
        <h1 className="text-xl font-bold italic tracking-tighter text-[#A855F7]">STELLAR</h1>
        <Search size={20} className="text-gray-400" />
      </header>

      {/* Featured Poster */}
      <div className="px-6 mb-8">
        <div className="relative aspect-[9/12] rounded-2xl overflow-hidden shadow-2xl group" onClick={() => onSelect(featured)}>
          <img src={featured.poster} className="w-full h-full object-cover" alt="featured" />
          <div className="absolute inset-0 stellar-gradient flex flex-col justify-end p-6">
            <h2 className="text-3xl font-bold mb-2">{featured.title}</h2>
            <div className="flex items-center space-x-4 mb-4 text-sm text-gray-300 font-medium">
              <span>{featured.episodes} Episodes</span>
              <span>•</span>
              <span>{featured.likes} Likes</span>
            </div>
            <button className="w-full bg-[#A855F7] py-3 rounded-eight font-bold flex items-center justify-center space-x-2 active:scale-95 transition-all">
              <Play fill="white" size={20} />
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
            <span className="text-xs text-[#A855F7] font-semibold">View All</span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {(videos.length > 0 ? videos : DEMO_VIDEOS).map(v => (
              <div key={v.id} className="space-y-2 group" onClick={() => onSelect(v)}>
                <div className="relative aspect-[9/13] rounded-eight overflow-hidden glass border-white/5">
                  <img src={v.poster} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" alt={v.title} />
                  {v.isVip && (
                    <span className="absolute top-2 left-2 bg-[#A855F7] text-[10px] font-bold px-2 py-0.5 rounded shadow-lg">VIP</span>
                  )}
                  <div className="absolute bottom-2 left-2 bg-black/60 backdrop-blur-md px-2 py-0.5 rounded text-[10px] font-bold">
                    EP {v.episodes}
                  </div>
                </div>
                <p className="text-sm font-semibold truncate">{v.title}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function PlayerScreen({ video, streamUrl, episodes, currentEpisode, onBack, onShowEpisodes, onNextEpisode }: { video: Video | null, streamUrl: string | null, episodes: any[], currentEpisode: number, onBack: () => void, onShowEpisodes: () => void, onNextEpisode: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState('00:00');
  const [duration, setDuration] = useState('00:00');
  const hideTimer = useRef<any>(null);

  // Reset player state when episode changes
  useEffect(() => {
    setProgress(0);
    setCurrentTime('00:00');
    setDuration('00:00');
    setShowOverlay(true);
    setIsPlaying(false);
  }, [currentEpisode]);

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
    }
  };

  // Auto-next on video end
  const handleEnded = () => {
    setIsPlaying(false);
    const maxEp = episodes.length;
    if (currentEpisode < maxEp) {
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

  return (
    <div className="h-full w-full relative bg-black" onClick={handleScreenTap}>
      {/* Video Element - key forces remount on episode change */}
      {streamUrl ? (
        <video 
          key={currentEpisode}
          ref={videoRef}
          src={streamUrl} 
          className="absolute inset-0 w-full h-full object-cover"
          autoPlay
          playsInline
          onPlay={handlePlay}
          onPause={handlePause}
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
        />
      ) : (
        <img src={video?.poster} className="absolute inset-0 w-full h-full object-cover opacity-60" alt="background" />
      )}

      {/* Overlay - auto-hide when playing */}
      <div className={`absolute inset-0 z-40 transition-opacity duration-500 ${showOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        {/* Back Button */}
        <button onClick={(e) => { e.stopPropagation(); onBack(); }} className="absolute top-6 left-6 z-50 p-2 glass rounded-full">
          <ChevronLeft size={24} />
        </button>

        {/* Episode Indicator */}
        <div className="absolute top-6 right-6 z-50 glass px-3 py-1.5 rounded-full">
          <span className="text-xs font-bold text-[#A855F7]">EP {currentEpisode}</span>
        </div>

        {/* Right Side Interaction Bar */}
        <div className="absolute right-4 bottom-56 flex flex-col items-center space-y-6 z-50">
          <div className="relative">
            <div className="w-12 h-12 rounded-full border-2 border-[#A855F7] overflow-hidden p-0.5">
              <img src="https://i.pravatar.cc/100" className="w-full h-full rounded-full" alt="avatar" />
            </div>
          </div>
          <div className="flex flex-col items-center">
            <Heart size={28} className="text-gray-200" />
            <span className="text-xs font-bold mt-1">{video?.likes}</span>
          </div>
          <div className="flex flex-col items-center">
            <MessageCircle size={28} className="text-gray-200" />
            <span className="text-xs font-bold mt-1">4.2K</span>
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
              {isPlaying ? <Lock size={32} /> : <Play size={32} fill="white" />}
            </button>
            <button onClick={(e) => { e.stopPropagation(); const v = videoRef.current; if (v) v.currentTime = Math.min(v.duration, v.currentTime + 10); }} className="p-3 bg-white/10 backdrop-blur-xl rounded-full">
              <SkipForward size={24} className="text-white/70" />
            </button>
          </div>
        </div>

        {/* Bottom Overlay - z-50 to sit above central controls */}
        <div className="absolute inset-x-0 bottom-0 stellar-gradient p-6 pb-8 z-50">
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-xl font-bold">{video?.title}</h2>
              <p className="text-xs text-gray-300 line-clamp-1 leading-relaxed opacity-80">
                Episode {currentEpisode} of {episodes.length || video?.episodes}
              </p>
            </div>

            <div className="flex items-center space-x-4">
              <button onClick={(e) => { e.stopPropagation(); onShowEpisodes(); }} className="flex-1 glass py-3 rounded-eight font-bold flex items-center justify-center space-x-2 active:scale-95 transition-transform">
                <List size={18} />
                <span>Episodes</span>
              </button>
              <button onClick={(e) => { e.stopPropagation(); onNextEpisode(); }} className={`flex-1 bg-[#A855F7] py-3 rounded-eight font-bold flex items-center justify-center space-x-2 active:scale-95 transition-transform ${currentEpisode >= episodes.length ? 'opacity-40' : ''}`}>
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

function EpisodeModal({ video, episodes, currentEpisode, isVip, onClose, onSelectEpisode }: { video: Video | null, episodes: any[], currentEpisode: number, isVip: boolean, onClose: () => void, onSelectEpisode: (ep: number) => void }) {
  const FREE_LIMIT = 5;
  const totalEps = episodes.length || (video?.episodes ?? 0);
  const epNumbers = Array.from({ length: totalEps }, (_, i) => i + 1);

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
            <div className={`px-3 py-1 rounded-full text-[10px] font-bold ${
              isVip 
                ? 'bg-[#A855F7]/20 text-[#A855F7] border border-[#A855F7]/40' 
                : 'bg-white/5 text-gray-400 border border-white/10'
            }`}>
              {isVip ? '👑 VIP Active' : '🔒 Free User'}
            </div>
          </div>
          <p className="text-[10px] text-[#A855F7] font-bold mt-3">▶ Now Playing: EP {currentEpisode}</p>
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
            {epNumbers.map(num => {
              const isCurrent = num === currentEpisode;
              const isLocked = !isVip && num > FREE_LIMIT;
              
              return (
                <button
                  key={num}
                  onClick={() => {
                    if (!isLocked) onSelectEpisode(num);
                  }}
                  className={`relative aspect-square rounded-xl flex flex-col items-center justify-center transition-all active:scale-90 ${
                    isCurrent
                      ? 'bg-[#A855F7] shadow-[0_0_15px_rgba(168,85,247,0.4)]'
                      : isLocked
                        ? 'bg-white/[0.03] border border-white/[0.06] opacity-50'
                        : 'bg-white/5 border border-white/10 hover:bg-white/10'
                  }`}
                >
                  {isLocked && (
                    <Lock size={12} className="text-gray-500 mb-0.5" />
                  )}
                  <span className={`text-sm font-bold ${
                    isCurrent ? 'text-white' : isLocked ? 'text-gray-600' : 'text-gray-200'
                  }`}>
                    {num}
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

function ProfileScreen({ user, isVip, vipUntil, telegramId, onSettings, onBack, onLogout }: { user: FireUser | null, isVip: boolean, vipUntil: string | null, telegramId: string | null, onSettings: () => void, onBack: () => void, onLogout: () => void }) {
  const [editTgId, setEditTgId] = useState(telegramId || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const saveTelegramId = async () => {
    if (!user || !editTgId.trim()) return;
    setSaving(true);
    try {
      await setDoc(doc(fireDb, 'users', user.uid), { telegramId: editTgId.trim() }, { merge: true });
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
          <div className={`inline-flex items-center space-x-1.5 mt-2 px-3 py-1 rounded-full text-[10px] font-bold ${
            isVip ? 'bg-[#A855F7]/20 text-[#A855F7] border border-[#A855F7]/40' : 'bg-white/5 text-gray-400 border border-white/10'
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
          <p className="text-[10px] text-gray-500">Masukkan Telegram ID untuk sinkronisasi status VIP dari bot</p>
          <div className="flex space-x-2">
            <input
              type="text"
              value={editTgId}
              onChange={(e) => setEditTgId(e.target.value)}
              placeholder="Contoh: 5888747846"
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
          <ProfileLink icon={<Bookmark size={20} />} label="My List" />
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

function SettingsScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="h-full overflow-y-auto">
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
                <QualityOption label="Auto (Recommended)" active />
                <QualityOption label="Higher Picture Quality" />
                <QualityOption label="Data Saver" />
              </div>
            </div>

            <div>
              <p className="text-sm font-bold mb-4 text-gray-300">Specific Resolution Limit</p>
              <div className="grid grid-cols-3 gap-3">
                {['4K', '1440p', '1080p', '720p', '480p', 'Auto'].map(res => (
                  <button key={res} className={`py-3 rounded-eight text-xs font-bold transition-all ${res === '1080p' ? 'bg-[#A855F7] border-[#A855F7]' : 'glass border-white/5'}`}>
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

function QualityOption({ label, active }: { label: string, active?: boolean }) {
  return (
    <div className={`p-4 rounded-xl flex items-center justify-between transition-all ${active ? 'bg-[#A855F7]/10 border border-[#A855F7]/50' : 'glass border-white/5'}`}>
      <span className={`text-sm font-bold ${active ? 'text-white' : 'text-gray-400'}`}>{label}</span>
      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${active ? 'border-[#A855F7] bg-[#A855F7]' : 'border-gray-600'}`}>
        {active && <Check size={12} className="text-white" />}
      </div>
    </div>
  );
}
