import { useState, useEffect } from 'react';
import axios from 'axios';
import { 
  LayoutDashboard, 
  Send, 
  Users, 
  CreditCard, 
  Activity, 
  ShieldCheck, 
  AlertCircle,
  CheckCircle,
  Ban,
  UserPlus,
  History
} from 'lucide-react';

const API_BASE = 'http://localhost:5000/api';

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [botStatus, setBotStatus] = useState({ status: 'Checking...', bot: '' });
  const [stats, setStats] = useState({ users: 0, videos: 0, pendingPayments: 0, activeVip: 0 });
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [users, setUsers] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [pendingPayments, setPendingPayments] = useState<any[]>([]);
  const [paymentHistory, setPaymentHistory] = useState<any[]>([]);
  const [broadcastHistory, setBroadcastHistory] = useState<any[]>([]);
  const [broadcastProgress, setBroadcastProgress] = useState<any>(null);

  useEffect(() => {
    fetchHealth();
    fetchStats();
    fetchUsers();
    fetchPayments();
    fetchHistory();
    
    // Initial status check
    fetchBroadcastStatus();
  }, []);

  useEffect(() => {
    let interval: any;
    if (broadcastProgress?.active) {
      interval = setInterval(fetchBroadcastStatus, 2000);
    }
    return () => clearInterval(interval);
  }, [broadcastProgress?.active]);

  const fetchBroadcastStatus = async () => {
    try {
      const res = await axios.get(`${API_BASE}/broadcast/status`);
      setBroadcastProgress(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchHealth = async () => {
    try {
      const res = await axios.get(`${API_BASE}/health`);
      setBotStatus(res.data);
    } catch {
      setBotStatus({ status: 'Offline', bot: 'Unknown' });
    }
  };

  const fetchStats = async () => {
    try {
      const res = await axios.get(`${API_BASE}/stats`);
      setStats(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await axios.get(`${API_BASE}/users${searchTerm ? `?search=${searchTerm}` : ''}`);
      setUsers(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    const delayDebounceFn = setTimeout(() => {
      fetchUsers();
    }, 500);

    return () => clearTimeout(delayDebounceFn);
  }, [searchTerm]);

  const fetchPayments = async () => {
    try {
      const res = await axios.get(`${API_BASE}/payments/pending`);
      setPendingPayments(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchHistory = async () => {
    try {
      const resP = await axios.get(`${API_BASE}/payments/history`);
      setPaymentHistory(resP.data);
      const resB = await axios.get(`${API_BASE}/broadcasts`);
      setBroadcastHistory(resB.data);
    } catch (err) {
      console.error(err);
    }
  };

  const handleBroadcast = async () => {
    if (!broadcastMsg) return;
    try {
      await axios.post(`${API_BASE}/broadcast`, { message: broadcastMsg });
      alert('Broadcast terkirim!');
      setBroadcastMsg('');
    } catch (err) {
      alert('Gagal mengirim broadcast');
    }
  };

  const handleVip = async (userId: number) => {
    const days = prompt('Berapa hari VIP?', '30');
    if (days) {
      try {
        await axios.post(`${API_BASE}/users/vip`, { userId, days: parseInt(days) });
        fetchUsers();
      } catch (err) {
        alert('Gagal tambah VIP');
      }
    }
  };

  const handleBan = async (userId: number) => {
    if (confirm('Yakin ingin membatasi user ini?')) {
      try {
        await axios.post(`${API_BASE}/users/ban`, { userId });
        fetchUsers();
      } catch (err) {
        alert('Gagal membatasi user');
      }
    }
  };

  const handleApprove = async (paymentId: number) => {
    try {
      await axios.post(`${API_BASE}/payments/approve`, { paymentId });
      fetchPayments();
      fetchUsers();
    } catch (err) {
      alert('Gagal approve pembayaran');
    }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <div className="w-64 glass-card m-4 mr-0 flex flex-col">
        <div className="p-6">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">XiaoYu</h1>
          <p className="text-xs text-gray-400 mt-1">Admin Panel Integration</p>
        </div>

        <nav className="flex-1 px-4 space-y-2">
          <NavItem icon={<LayoutDashboard size={20} />} label="Dashboard" active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} />
          <NavItem icon={<Send size={20} />} label="Broadcast" active={activeTab === 'broadcast'} onClick={() => setActiveTab('broadcast')} />
          <NavItem icon={<Users size={20} />} label="User Management" active={activeTab === 'users'} onClick={() => setActiveTab('users')} />
          <NavItem icon={<CreditCard size={20} />} label="Payments" active={activeTab === 'payments'} onClick={() => setActiveTab('payments')} />
          <NavItem icon={<History size={20} />} label="Riwayat" active={activeTab === 'history'} onClick={() => setActiveTab('history')} />
          <NavItem icon={<Activity size={20} />} label="Activity Logs" active={activeTab === 'logs'} onClick={() => setActiveTab('logs')} />
        </nav>

        <div className="p-4 mt-auto">
          <div className="glass-card p-3 flex items-center space-x-3">
            <div className={`w-3 h-3 rounded-full ${botStatus.status === 'Online' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500'}`} />
            <div>
              <p className="text-xs font-semibold">Bot API: {botStatus.status}</p>
              <p className="text-[10px] text-gray-400">@{botStatus.bot || 'unknown'}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-8">
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <h2 className="text-3xl font-bold">Dashboard Overview</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <StatCard label="Total Users" value={stats.users} icon={<Users className="text-blue-400" />} />
              <StatCard label="Total Videos" value={stats.videos} icon={<Activity className="text-green-400" />} />
              <StatCard label="VIP Active" value={stats.activeVip} icon={<ShieldCheck className="text-purple-400" />} />
              <StatCard label="Pending Payments" value={stats.pendingPayments} icon={<AlertCircle className="text-yellow-400" />} />
            </div>
          </div>
        )}

        {activeTab === 'broadcast' && (
          <div className="space-y-6 max-w-2xl">
            <h2 className="text-3xl font-bold">Broadcast Panel</h2>
            
            {broadcastProgress?.active && (
              <div className="glass-card p-6 space-y-4 border-blue-500/50">
                <div className="flex justify-between items-center">
                  <h3 className="font-bold flex items-center space-x-2">
                    <Activity className="animate-pulse text-blue-400" size={18} />
                    <span>Broadcast Sedang Berjalan...</span>
                  </h3>
                  <button 
                    onClick={() => axios.post(`${API_BASE}/broadcast/stop`)}
                    className="text-xs bg-red-500/20 text-red-400 px-3 py-1 rounded hover:bg-red-500/30"
                  >
                    Hentikan
                  </button>
                </div>
                
                <div className="w-full bg-white/5 rounded-full h-2 overflow-hidden">
                  <div 
                    className="bg-blue-500 h-full transition-all duration-500" 
                    style={{ width: `${(broadcastProgress.current / broadcastProgress.total) * 100}%` }}
                  />
                </div>
                
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div className="p-2 bg-white/5 rounded-lg">
                    <p className="text-[10px] text-gray-400">Proses</p>
                    <p className="font-bold">{broadcastProgress.current} / {broadcastProgress.total}</p>
                  </div>
                  <div className="p-2 bg-white/5 rounded-lg">
                    <p className="text-[10px] text-gray-400">Sukses</p>
                    <p className="font-bold text-green-400">{broadcastProgress.success}</p>
                  </div>
                  <div className="p-2 bg-white/5 rounded-lg">
                    <p className="text-[10px] text-gray-400">Gagal</p>
                    <p className="font-bold text-red-400">{broadcastProgress.fail}</p>
                  </div>
                </div>
              </div>
            )}

            <div className="glass-card p-6 space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-2">Broadcast Message (HTML Supported)</label>
                <textarea 
                  className="w-full h-40 glass-input resize-none"
                  placeholder="Contoh: <b>Halo!</b> Ini adalah pesan broadcast. <a href='https://t.me/...'>Link</a>"
                  value={broadcastMsg}
                  onChange={(e) => setBroadcastMsg(e.target.value)}
                />
                <p className="text-[10px] text-gray-500 mt-2">Gunakan tag HTML seperti &lt;b&gt;, &lt;i&gt;, &lt;code&gt;, &lt;a&gt;.</p>
              </div>
              <button 
                className="glass-button w-full flex items-center justify-center space-x-2 disabled:opacity-50"
                onClick={handleBroadcast}
                disabled={broadcastProgress?.active}
              >
                <Send size={18} />
                <span>{broadcastProgress?.active ? 'Sedang Berjalan...' : 'Kirim ke Semua User'}</span>
              </button>
            </div>
          </div>
        )}

        {activeTab === 'users' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-3xl font-bold">User Management</h2>
              <div className="relative w-64">
                <input 
                  type="text" 
                  placeholder="Cari ID atau Username..." 
                  className="w-full glass-input pl-10"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <Users className="absolute left-3 top-2.5 text-gray-400" size={18} />
              </div>
            </div>
            <div className="glass-card overflow-hidden">
              <table className="w-full text-left">
                <thead className="bg-white/5 border-b border-glass-border">
                  <tr>
                    <th className="px-6 py-4 font-medium text-gray-400">Telegram ID</th>
                    <th className="px-6 py-4 font-medium text-gray-400">Username</th>
                    <th className="px-6 py-4 font-medium text-gray-400">VIP Status</th>
                    <th className="px-6 py-4 font-medium text-gray-400">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-glass-border">
                  {users.map(user => (
                    <tr key={user.user_id} className="hover:bg-white/5 transition-colors">
                      <td className="px-6 py-4 text-sm">{user.user_id}</td>
                      <td className="px-6 py-4 font-medium">@{user.username || 'unknown'}</td>
                      <td className="px-6 py-4">
                        {user.vip_until && new Date(user.vip_until) > new Date() ? (
                          <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded-full border border-green-500/30">Aktif</span>
                        ) : (
                          <span className="px-2 py-1 bg-gray-500/20 text-gray-400 text-xs rounded-full border border-gray-500/30">Free</span>
                        )}
                      </td>
                      <td className="px-6 py-4 flex space-x-3">
                        <button onClick={() => handleVip(user.user_id)} className="p-2 hover:bg-blue-500/20 rounded-lg text-blue-400 transition-colors" title="Tambah VIP">
                          <UserPlus size={18} />
                        </button>
                        <button onClick={() => handleBan(user.user_id)} className="p-2 hover:bg-red-500/20 rounded-lg text-red-400 transition-colors" title="Ban/Hapus">
                          <Ban size={18} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="space-y-8">
            <div className="space-y-4">
              <h2 className="text-3xl font-bold flex items-center space-x-3">
                <History className="text-blue-400" />
                <span>Riwayat Pembelian VIP</span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {paymentHistory.map(pay => (
                  <div key={pay.id} className="glass-card p-5 space-y-3 relative overflow-hidden">
                    <div className="absolute top-0 right-0 bg-green-500/20 text-green-400 text-[10px] px-2 py-1 rounded-bl-lg font-bold">SUCCESS</div>
                    <div className="space-y-1">
                      <div className="flex items-center space-x-2 text-sm">
                        <span className="text-gray-400">👤 User:</span>
                        <span className="font-bold text-blue-300">{pay.first_name} (@{pay.username || 'None'})</span>
                      </div>
                      <div className="flex items-center space-x-2 text-sm">
                        <span className="text-gray-400">🆔 ID:</span>
                        <code className="bg-black/30 px-1 rounded">{pay.user_id}</code>
                      </div>
                      <div className="flex items-center space-x-2 text-sm">
                        <span className="text-gray-400">💰 Nominal:</span>
                        <span className="font-bold text-green-400">Rp {pay.amount?.toLocaleString() || '0'}</span>
                      </div>
                      <div className="flex items-center space-x-2 text-sm">
                        <span className="text-gray-400">📦 Paket:</span>
                        <span className="bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded text-xs">{pay.days} Hari ({pay.payment_type || 'REGULAR'})</span>
                      </div>
                      <div className="flex items-center space-x-2 text-sm mt-3 pt-2 border-t border-white/5">
                        <span className="text-gray-400">✅ Diproses oleh:</span>
                        <span className="text-purple-300 font-medium">ADMIN / XIAOYU</span>
                      </div>
                      <p className="text-[10px] text-gray-500 mt-2 italic">{pay.approved_at}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-4 pt-8 border-t border-white/10">
              <h2 className="text-3xl font-bold flex items-center space-x-3">
                <Send className="text-blue-400" />
                <span>Riwayat Broadcast</span>
              </h2>
              <div className="glass-card overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-white/5 border-b border-glass-border text-gray-400 text-sm">
                    <tr>
                      <th className="p-4 font-medium">Tanggal</th>
                      <th className="p-4 font-medium">Pesan</th>
                      <th className="p-4 font-medium">Total</th>
                      <th className="p-4 font-medium text-green-400">Sukses</th>
                      <th className="p-4 font-medium text-red-400">Gagal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-glass-border">
                    {broadcastHistory.map(bc => (
                      <tr key={bc.id} className="hover:bg-white/5 transition-colors">
                        <td className="p-4 text-xs text-gray-400">{bc.created_at}</td>
                        <td className="p-4">
                          <p className="text-sm line-clamp-1 max-w-xs">{bc.content || bc.message_text}</p>
                        </td>
                        <td className="p-4 font-medium">{bc.total_recipients}</td>
                        <td className="p-4 text-green-400">{bc.success_count}</td>
                        <td className="p-4 text-red-400">{bc.fail_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'payments' && (
          <div className="space-y-6">
            <h2 className="text-3xl font-bold">Bayar Pending</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {pendingPayments.map(payment => (
                <div key={payment.id} className="glass-card p-6 flex flex-col">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="font-bold">Pembayaran #{payment.id}</h3>
                      <p className="text-sm text-gray-400">User: @{payment.username || payment.user_id}</p>
                    </div>
                    <span className="px-2 py-1 bg-yellow-500/20 text-yellow-400 text-xs rounded-full">PENDING</span>
                  </div>
                  <div className="flex-1 mb-6">
                    <p className="text-xs text-gray-400 mb-1">Proof File ID:</p>
                    <code className="text-[10px] bg-black/30 p-2 rounded block break-all">{payment.proof_file_id}</code>
                  </div>
                  <button 
                    className="glass-button bg-green-600 hover:bg-green-700 flex items-center justify-center space-x-2"
                    onClick={() => handleApprove(payment.id)}
                  >
                    <CheckCircle size={18} />
                    <span>Approve & Aktifkan VIP</span>
                  </button>
                </div>
              ))}
              {pendingPayments.length === 0 && (
                <div className="glass-card p-12 col-span-2 flex flex-col items-center justify-center text-gray-500">
                  <CreditCard size={48} className="mb-4 opacity-20" />
                  <p>Tidak ada pembayaran pending.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: any, label: string, active?: boolean, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-all ${
        active 
          ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]' 
          : 'text-gray-400 hover:bg-white/5 hover:text-white'
      }`}
    >
      {icon}
      <span className="font-medium">{label}</span>
    </button>
  );
}

function StatCard({ label, value, icon }: { label: string, value: any, icon: any }) {
  return (
    <div className="glass-card p-6 flex items-center space-x-4">
      <div className="p-3 bg-white/5 rounded-xl">
        {icon}
      </div>
      <div>
        <p className="text-sm text-gray-400">{label}</p>
        <p className="text-2xl font-bold">{value}</p>
      </div>
    </div>
  );
}

export default App;
