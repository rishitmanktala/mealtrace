'use strict';

const STORAGE_KEYS = {
  GOALS: 'mt_goals',
  LOG: 'mt_log',
};

const DEFAULT_GOALS = { calories: 2000, protein: 150, carbs: 250, fat: 65, fiber: 30 };
const MAX_CLIENT_IMAGE_BYTES = 3.6 * 1024 * 1024;
const LOCAL_API_ORIGIN = 'http://localhost:4173';
const PRODUCTION_API_ORIGIN = 'https://mealtrace.onrender.com';
const SYNC_DAYS = 30;

let supabaseClient = null;
let currentSession = null;
let currentUser = null;
let currentInputMode = 'photo';
let currentImage = null;
let currentResult = null;
let macroChart = null;
let mediaStream = null;
let goalsCache = { ...DEFAULT_GOALS };
let mealLogCache = {};

document.addEventListener('DOMContentLoaded', async () => {
  setNavDate();
  attachEventListeners();
  await initAuth();
});

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function storageKey(baseKey) {
  return currentUser?.id ? `${baseKey}:${currentUser.id}` : `${baseKey}:anonymous`;
}

function legacyStorageKey(baseKey) {
  const legacyPrefix = ['c', 't'].join('');
  const legacyKey = baseKey === STORAGE_KEYS.GOALS ? `${legacyPrefix}_goals` : `${legacyPrefix}_log`;
  return currentUser?.id ? `${legacyKey}:${currentUser.id}` : `${legacyKey}:anonymous`;
}

async function initAuth() {
  setAuthMessage('Checking session...');

  try {
    const config = await loadAuthConfig();
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    supabaseClient.auth.onAuthStateChange((_event, session) => {
      currentSession = session;
      if (!session) {
        currentUser = null;
        showAuthScreen();
      }
    });

    const { data: sessionData } = await supabaseClient.auth.getSession();
    currentSession = sessionData?.session || null;
    if (!currentSession) {
      showAuthScreen();
      return;
    }

    await verifyCurrentUser();
  } catch (error) {
    showAuthScreen(error.message || 'Authentication is not configured yet.');
  }
}

async function loadAuthConfig() {
  const endpoints = getApiEndpoints('/api/config');
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint);
      const config = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(config.error || 'Could not load Supabase configuration.');
      }
      if (!config.supabaseUrl || !config.supabaseAnonKey) {
        throw new Error('Supabase URL and anon key are missing on the server.');
      }
      return config;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError?.message === 'Failed to fetch') {
    throw new Error('MealTrace needs the API server for sign-in and analysis. Run node server.js and open http://localhost:4173.');
  }
  throw lastError || new Error('Could not load Supabase configuration.');
}

async function verifyCurrentUser() {
  if (!supabaseClient) return;
  const { data, error } = await supabaseClient.auth.getUser();
  if (error || !data?.user) {
    currentSession = null;
    currentUser = null;
    showAuthScreen('Please sign in to continue.');
    return;
  }

  currentUser = data.user;
  await bootAuthenticatedApp();
}

async function bootAuthenticatedApp() {
  document.getElementById('userEmail').textContent = currentUser.email || 'Signed in';
  document.getElementById('authScreen').hidden = true;
  document.getElementById('appShell').hidden = false;
  loadLocalState();
  loadSettings();
  loadLog();
  updateDashboard();
  updateHeroStats();
  setAuthLoading(false);
  setAuthMessage('');
  await hydrateSyncedState();
}

function showAuthScreen(message = 'Please sign in to continue.') {
  document.getElementById('appShell').hidden = true;
  document.getElementById('authScreen').hidden = false;
  setAuthLoading(false);
  setAuthMessage(message);
}

async function signIn() {
  if (!supabaseClient) {
    setAuthMessage('Supabase is not configured yet.', true);
    return;
  }
  const credentials = getAuthCredentials();
  if (!credentials) return;

  setAuthLoading(true);
  setAuthMessage('Signing in...');
  const { data, error } = await supabaseClient.auth.signInWithPassword(credentials);
  if (error) {
    setAuthLoading(false);
    setAuthMessage(error.message, true);
    return;
  }

  currentSession = data.session;
  await verifyCurrentUser();
}

async function signUp() {
  if (!supabaseClient) {
    setAuthMessage('Supabase is not configured yet.', true);
    return;
  }
  const credentials = getAuthCredentials();
  if (!credentials) return;

  setAuthLoading(true);
  setAuthMessage('Creating account...');
  const { data, error } = await supabaseClient.auth.signUp(credentials);
  if (error) {
    setAuthLoading(false);
    setAuthMessage(error.message, true);
    return;
  }

  if (data.session) {
    currentSession = data.session;
    await verifyCurrentUser();
    return;
  }

  setAuthLoading(false);
  setAuthMessage('Account created. Check your email to confirm your address, then sign in.');
}

async function signOut() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  currentSession = null;
  currentUser = null;
  resetAnalysisFlow();
  showAuthScreen('Signed out.');
}

function getAuthCredentials() {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  if (!email || !password) {
    setAuthMessage('Enter your email and password.', true);
    return null;
  }
  return { email, password };
}

function setAuthLoading(on) {
  document.getElementById('signInBtn').disabled = on;
  document.getElementById('signUpBtn').disabled = on;
}

function setAuthMessage(message, isError = false) {
  const el = document.getElementById('authMessage');
  el.textContent = message;
  el.classList.toggle('error', isError);
}

function setNavDate() {
  const navDate = document.getElementById('navDate');
  if (!navDate) return;
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  navDate.textContent = new Date().toLocaleDateString('en-US', opts);
}

function parseJsonStorage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function loadLocalState() {
  const savedGoals = parseJsonStorage(storageKey(STORAGE_KEYS.GOALS), null)
    || parseJsonStorage(legacyStorageKey(STORAGE_KEYS.GOALS), null)
    || {};
  goalsCache = { ...DEFAULT_GOALS, ...savedGoals };
  mealLogCache = parseJsonStorage(storageKey(STORAGE_KEYS.LOG), null)
    || parseJsonStorage(legacyStorageKey(STORAGE_KEYS.LOG), null)
    || {};
}

function saveLocalState() {
  localStorage.setItem(storageKey(STORAGE_KEYS.GOALS), JSON.stringify(goalsCache));
  localStorage.setItem(storageKey(STORAGE_KEYS.LOG), JSON.stringify(mealLogCache));
}

async function hydrateSyncedState() {
  if (!supabaseClient || !currentUser) return;
  try {
    const localHadMeals = Object.values(mealLogCache).some(day => Array.isArray(day) && day.length);
    await loadRemoteGoals();
    const remoteHadMeals = await loadRemoteMeals();
    saveLocalState();
    loadSettings();
    loadLog();
    updateDashboard();
    updateHeroStats();
    if (localHadMeals && !remoteHadMeals) await migrateLocalMeals();
  } catch (error) {
    console.warn('Sync unavailable', error);
    showToast('Using local data until sync is available', true);
  }
}

async function loadRemoteGoals() {
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('goals')
    .eq('user_id', currentUser.id)
    .maybeSingle();
  if (error) throw error;
  if (data?.goals) {
    goalsCache = { ...DEFAULT_GOALS, ...data.goals };
    return;
  }
  await syncGoals();
}

async function loadRemoteMeals() {
  const since = new Date();
  since.setDate(since.getDate() - SYNC_DAYS);
  const { data, error } = await supabaseClient
    .from('meal_logs')
    .select('id, logged_on, data')
    .gte('logged_on', since.toISOString().slice(0, 10))
    .order('logged_at', { ascending: false });
  if (error) throw error;

  const nextCache = {};
  (data || []).forEach(row => {
    if (!row.logged_on || !row.data) return;
    if (!nextCache[row.logged_on]) nextCache[row.logged_on] = [];
    nextCache[row.logged_on].push({ ...row.data, id: row.id });
  });
  mealLogCache = nextCache;
  return Boolean(data?.length);
}

async function migrateLocalMeals() {
  const meals = Object.entries(mealLogCache).flatMap(([loggedOn, mealsForDay]) => {
    if (!Array.isArray(mealsForDay)) return [];
    return mealsForDay.map(meal => ({ logged_on: loggedOn, data: normalizeMealEntry(meal) }));
  });
  if (!meals.length) return;
  const rows = meals.map(meal => ({
    user_id: currentUser.id,
    logged_on: meal.logged_on,
    logged_at: new Date(Number(meal.data.id) || Date.now()).toISOString(),
    data: meal.data,
  }));
  const { error } = await supabaseClient.from('meal_logs').insert(rows);
  if (error) throw error;
  await loadRemoteMeals();
  saveLocalState();
  loadLog();
}

function getGoals() {
  return { ...DEFAULT_GOALS, ...goalsCache };
}

function loadSettings() {
  const goals = getGoals();
  document.getElementById('goalCalInput').value = goals.calories;
  document.getElementById('goalProtInput').value = goals.protein;
  document.getElementById('goalCarbInput').value = goals.carbs;
  document.getElementById('goalFatInput').value = goals.fat;
  document.getElementById('goalFiberInput').value = goals.fiber;
}

async function saveSettings() {
  goalsCache = {
    calories: +document.getElementById('goalCalInput').value || DEFAULT_GOALS.calories,
    protein: +document.getElementById('goalProtInput').value || DEFAULT_GOALS.protein,
    carbs: +document.getElementById('goalCarbInput').value || DEFAULT_GOALS.carbs,
    fat: +document.getElementById('goalFatInput').value || DEFAULT_GOALS.fat,
    fiber: +document.getElementById('goalFiberInput').value || DEFAULT_GOALS.fiber,
  };
  saveLocalState();
  closeModal();
  updateDashboard();
  try {
    await syncGoals();
    showToast('Settings saved');
  } catch {
    showToast('Settings saved locally. Sync will retry after reload.', true);
  }
}

async function syncGoals() {
  if (!supabaseClient || !currentUser) return;
  const { error } = await supabaseClient
    .from('profiles')
    .upsert({
      user_id: currentUser.id,
      goals: goalsCache,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
  if (error) throw error;
}

function getTodayLog() {
  return mealLogCache[todayKey()] || [];
}

function saveTodayLog(log) {
  mealLogCache[todayKey()] = log;
  const keys = Object.keys(mealLogCache).sort();
  while (keys.length > 14) {
    delete mealLogCache[keys.shift()];
  }
  saveLocalState();
}

function normalizeMealEntry(entry) {
  return {
    id: entry.id || createId(),
    time: entry.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    name: entry.name || 'Meal',
    thumb: entry.thumb || '',
    calories: numberOrZero(entry.calories),
    protein: numberOrZero(entry.protein),
    carbs: numberOrZero(entry.carbs),
    fat: numberOrZero(entry.fat),
    fiber: numberOrZero(entry.fiber),
    sugar: numberOrZero(entry.sugar),
    sodium: numberOrZero(entry.sodium),
    calcium: numberOrZero(entry.calcium),
    iron: numberOrZero(entry.iron),
    potassium: numberOrZero(entry.potassium),
    vitD: numberOrZero(entry.vitD),
  };
}

function createId() {
  return window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function syncMeal(entry) {
  if (!supabaseClient || !currentUser) return;
  const { error } = await supabaseClient.from('meal_logs').upsert({
    id: entry.id,
    user_id: currentUser.id,
    logged_on: todayKey(),
    logged_at: new Date().toISOString(),
    data: entry,
  }, { onConflict: 'id' });
  if (error) throw error;
}

async function deleteRemoteMeal(id) {
  if (!supabaseClient || !currentUser) return;
  const { error } = await supabaseClient
    .from('meal_logs')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

async function clearRemoteTodayLog() {
  if (!supabaseClient || !currentUser) return;
  const { error } = await supabaseClient
    .from('meal_logs')
    .delete()
    .eq('logged_on', todayKey());
  if (error) throw error;
}

function attachEventListeners() {
  document.getElementById('authForm').addEventListener('submit', event => {
    event.preventDefault();
    signIn();
  });
  document.getElementById('signUpBtn').addEventListener('click', signUp);
  document.getElementById('signOutBtn').addEventListener('click', signOut);
  document.getElementById('settingsBtn').addEventListener('click', openModal);
  document.getElementById('editGoalsShortcut')?.addEventListener('click', openModal);
  document.getElementById('closeSettings').addEventListener('click', closeModal);
  document.getElementById('saveSettings').addEventListener('click', saveSettings);
  document.getElementById('settingsOverlay').addEventListener('click', event => {
    if (event.target === document.getElementById('settingsOverlay')) closeModal();
  });

  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  document.getElementById('photoModeBtn').addEventListener('click', () => setInputMode('photo'));
  document.getElementById('textModeBtn').addEventListener('click', () => setInputMode('text'));
  document.getElementById('mealTextInput').addEventListener('input', () => {
    hideResult();
    updateAnalyzeButtonState();
    document.getElementById('analyzeAnotherBtn').disabled = !getMealDescription();
  });
  document.getElementById('browseBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', event => handleFile(event.target.files[0]));
  dropZone.addEventListener('dragover', event => {
    event.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', event => {
    event.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = event.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) handleFile(file);
  });

  document.getElementById('cameraBtn').addEventListener('click', openCamera);
  document.getElementById('closeCameraBtn').addEventListener('click', closeCamera);
  document.getElementById('captureBtn').addEventListener('click', capturePhoto);
  document.getElementById('removeBtn').addEventListener('click', resetUpload);
  document.getElementById('analyzeBtn').addEventListener('click', analyzeMeal);
  document.getElementById('logMealBtn').addEventListener('click', logMeal);
  document.getElementById('analyzeAnotherBtn').addEventListener('click', resetAnalysisFlow);

  document.getElementById('clearLogBtn')?.addEventListener('click', async () => {
    if (!getTodayLog().length) {
      showToast('Meal log is already empty');
      return;
    }
    if (!confirm('Clear all meals logged today?')) return;
    saveTodayLog([]);
    loadLog();
    updateDashboard();
    updateHeroStats();
    try {
      await clearRemoteTodayLog();
      showToast('Log cleared');
    } catch {
      showToast('Log cleared locally. Sync will retry after reload.', true);
    }
  });
}

function setInputMode(mode) {
  if (mode === currentInputMode) return;
  currentInputMode = mode;
  document.getElementById('photoModeBtn').classList.toggle('active', mode === 'photo');
  document.getElementById('textModeBtn').classList.toggle('active', mode === 'text');
  document.getElementById('photoModeBtn').setAttribute('aria-pressed', String(mode === 'photo'));
  document.getElementById('textModeBtn').setAttribute('aria-pressed', String(mode === 'text'));
  document.getElementById('dropZone').hidden = mode !== 'photo';
  document.getElementById('manualEntry').hidden = mode !== 'text';
  document.getElementById('reviewHint').textContent = mode === 'photo'
    ? 'Choose a meal photo above to see an estimated nutrition breakdown.'
    : 'Describe the meal above to see an estimated nutrition breakdown.';

  withTransition(() => {
    hideResult();
    if (mode === 'photo') {
      clearMealDescription();
    } else {
      resetUpload();
    }
    updateAnalyzeButtonState();
    document.getElementById('analyzeAnotherBtn').disabled = true;
  });
}

function withTransition(callback) {
  if (document.startViewTransition) {
    document.startViewTransition(callback);
  } else {
    callback();
  }
}

function openModal() {
  document.getElementById('settingsOverlay').showModal();
}

function closeModal() {
  document.getElementById('settingsOverlay').close();
}

async function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('Choose an image file', true);
    return;
  }

  try {
    currentImage = await compressImage(file);
    withTransition(() => {
      showPreview(currentImage);
      hideResult();
      document.getElementById('analyzeAnotherBtn').disabled = false;
    });
  } catch (error) {
    showToast(error.message || 'Could not read image', true);
  }
}

function showPreview(src) {
  document.getElementById('previewImg').src = src;
  document.getElementById('dropInner').hidden = true;
  document.getElementById('previewInner').hidden = false;
  updateAnalyzeButtonState();
}

function resetUpload() {
  currentImage = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('previewImg').src = '';
  document.getElementById('dropInner').hidden = false;
  document.getElementById('previewInner').hidden = true;
  updateAnalyzeButtonState();
}

function resetAnalysisFlow() {
  withTransition(() => {
    hideResult();
    resetUpload();
    clearMealDescription();
    document.getElementById('analyzeAnotherBtn').disabled = true;
  });
}

async function compressImage(fileOrDataUrl) {
  const dataUrl = typeof fileOrDataUrl === 'string' ? fileOrDataUrl : await readFileAsDataUrl(fileOrDataUrl);
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

  const qualities = [0.86, 0.78, 0.68, 0.58, 0.48];
  for (const quality of qualities) {
    const compressed = canvas.toDataURL('image/jpeg', quality);
    if (estimateDataUrlBytes(compressed) <= MAX_CLIENT_IMAGE_BYTES) return compressed;
  }
  throw new Error('Image is too large after compression. Try a smaller photo.');
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => resolve(event.target.result);
    reader.onerror = () => reject(new Error('Could not read image file'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}

function estimateDataUrlBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  return Math.ceil((base64.length * 3) / 4);
}

async function openCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    document.getElementById('cameraVideo').srcObject = mediaStream;
    document.getElementById('cameraModal').showModal();
  } catch {
    showToast('Camera is not accessible', true);
  }
}

function closeCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  document.getElementById('cameraModal').close();
}

async function capturePhoto() {
  const video = document.getElementById('cameraVideo');
  const canvas = document.getElementById('cameraCanvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
  closeCamera();
  currentImage = await compressImage(dataUrl);
  withTransition(() => {
    showPreview(currentImage);
    hideResult();
  });
}

async function analyzeMeal() {
  const mealDescription = getMealDescription();
  if (currentInputMode === 'photo' && !currentImage) return;
  if (currentInputMode === 'text' && !mealDescription) return;

  setBtnLoading(true);
  try {
    const payload = await requestMealAnalysis({
      imageDataUrl: currentInputMode === 'photo' ? currentImage : '',
      mealDescription: currentInputMode === 'text' ? mealDescription : '',
    });
    currentResult = normalizeNutrition(payload);
    withTransition(() => {
      showResult(currentResult);
    });
    showToast('Analysis ready');
  } catch (error) {
    showToast(error.message || 'Analysis failed', true);
  } finally {
    setBtnLoading(false);
  }
}

async function requestMealAnalysis({ imageDataUrl = '', mealDescription = '' }) {
  const token = currentSession?.access_token;
  if (!token) {
    showAuthScreen('Please sign in to continue.');
    throw new Error('Please sign in to analyze a meal.');
  }

  const body = JSON.stringify({ imageDataUrl, mealDescription });
  const endpoints = getAnalysisEndpoints();
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Analysis failed (${response.status})`);
      }
      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError?.message === 'Failed to fetch') {
    throw new Error('Cannot reach the analysis service. Start the app with `node server.js` and open http://localhost:4173.');
  }
  throw lastError || new Error('Analysis failed');
}

function getAnalysisEndpoints() {
  return getApiEndpoints('/api/analyze-meal');
}

function getApiEndpoints(path) {
  const sameOrigin = path;
  if (isGitHubPagesHost()) return [`${PRODUCTION_API_ORIGIN}${path}`];
  if (window.location.origin === LOCAL_API_ORIGIN) return [sameOrigin];
  return [sameOrigin, `${LOCAL_API_ORIGIN}${path}`];
}

function isStaticHost() {
  return window.location.protocol === 'file:' || isGitHubPagesHost();
}

function isGitHubPagesHost() {
  return /\.github\.io$/i.test(window.location.hostname);
}

function normalizeNutrition(n) {
  return {
    food_name: String(n.food_name || 'Estimated meal'),
    serving_description: String(n.serving_description || 'Estimated serving'),
    calories: numberOrZero(n.calories),
    protein_g: numberOrZero(n.protein_g),
    carbohydrates_g: numberOrZero(n.carbohydrates_g),
    fat_g: numberOrZero(n.fat_g),
    fiber_g: numberOrZero(n.fiber_g),
    sugar_g: numberOrZero(n.sugar_g),
    saturated_fat_g: numberOrZero(n.saturated_fat_g),
    sodium_mg: numberOrZero(n.sodium_mg),
    potassium_mg: numberOrZero(n.potassium_mg),
    cholesterol_mg: numberOrZero(n.cholesterol_mg),
    vitamins: n.vitamins || {},
    minerals: n.minerals || {},
  };
}

function numberOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function setBtnLoading(on) {
  document.getElementById('analyzeBtn').disabled = on || !canAnalyze();
  document.getElementById('analyzeBtnText').hidden = on;
  document.getElementById('btnSpinner').hidden = !on;
}

function canAnalyze() {
  return currentInputMode === 'photo' ? Boolean(currentImage) : Boolean(getMealDescription());
}

function updateAnalyzeButtonState() {
  document.getElementById('analyzeBtn').disabled = !canAnalyze();
}

function getMealDescription() {
  return document.getElementById('mealTextInput').value.trim();
}

function clearMealDescription() {
  document.getElementById('mealTextInput').value = '';
}

function showResult(n) {
  document.getElementById('emptyAnalysis').hidden = true;
  document.getElementById('analysisResult').hidden = false;
  document.getElementById('logMealBtn').disabled = false;
  document.getElementById('analyzeAnotherBtn').disabled = false;

  const resultFoodName = document.getElementById('resultFoodName');
  resultFoodName.textContent = `${n.food_name} - ${n.serving_description}`;
  document.getElementById('resultCalories').textContent = Math.round(n.calories);
  document.getElementById('macroTotal').textContent = Math.round(n.calories);
  document.getElementById('legendCarbs').textContent = `${Math.round(n.carbohydrates_g)}g`;
  document.getElementById('legendProtein').textContent = `${Math.round(n.protein_g)}g`;
  document.getElementById('legendFat').textContent = `${Math.round(n.fat_g)}g`;

  buildMacroChart(n);
  buildNutrientGrid(n);
  buildVitaminChips(n);
}

function hideResult() {
  document.getElementById('emptyAnalysis').hidden = false;
  document.getElementById('analysisResult').hidden = true;
  document.getElementById('logMealBtn').disabled = true;
  currentResult = null;
  if (macroChart) {
    macroChart.destroy();
    macroChart = null;
  }
}

function buildMacroChart(n) {
  if (macroChart) macroChart.destroy();
  const ctx = document.getElementById('macroChart').getContext('2d');
  macroChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Carbs', 'Protein', 'Fat'],
      datasets: [{
        data: [
          Math.max(1, Math.round(n.carbohydrates_g * 4)),
          Math.max(1, Math.round(n.protein_g * 4)),
          Math.max(1, Math.round(n.fat_g * 9)),
        ],
        backgroundColor: ['#3677b9', '#2f9e60', '#e86d54'],
        borderColor: '#f9fbf7',
        borderWidth: 4,
        hoverOffset: 4,
      }],
    },
    options: {
      cutout: '72%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: context => ` ${context.label}: ${context.raw} kcal` } },
      },
      animation: { animateRotate: true, duration: 700 },
    },
  });
}

function buildNutrientGrid(n) {
  const grid = document.getElementById('nutrientGrid');
  grid.innerHTML = '';
  const items = [
    { name: 'Protein', val: Math.round(n.protein_g), unit: 'g' },
    { name: 'Carbs', val: Math.round(n.carbohydrates_g), unit: 'g' },
    { name: 'Fat', val: Math.round(n.fat_g), unit: 'g' },
    { name: 'Fiber', val: formatOne(n.fiber_g), unit: 'g' },
    { name: 'Sugar', val: formatOne(n.sugar_g), unit: 'g' },
    { name: 'Sodium', val: Math.round(n.sodium_mg), unit: 'mg' },
  ];

  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'nutrient-item';
    const name = document.createElement('span');
    name.className = 'nutrient-name';
    name.textContent = item.name;
    const val = document.createElement('span');
    val.className = 'nutrient-val';
    val.textContent = `${item.val} `;
    const unit = document.createElement('span');
    unit.className = 'nutrient-unit';
    unit.textContent = item.unit;
    val.appendChild(unit);
    el.append(name, val);
    grid.appendChild(el);
  });
}

function buildVitaminChips(n) {
  const container = document.getElementById('vitaminChips');
  container.innerHTML = '';
  const vit = n.vitamins || {};
  const min = n.minerals || {};
  const chips = [
    { label: 'Vit A', val: vit.vitamin_a_mcg, unit: 'ug' },
    { label: 'Vit B6', val: vit.vitamin_b6_mg, unit: 'mg' },
    { label: 'Vit B12', val: vit.vitamin_b12_mcg, unit: 'ug' },
    { label: 'Vit C', val: vit.vitamin_c_mg, unit: 'mg' },
    { label: 'Vit D', val: vit.vitamin_d_mcg, unit: 'ug' },
    { label: 'Calcium', val: min.calcium_mg, unit: 'mg', mineral: true },
    { label: 'Iron', val: min.iron_mg, unit: 'mg', mineral: true },
    { label: 'Magnesium', val: min.magnesium_mg, unit: 'mg', mineral: true },
  ];

  chips.forEach(chip => {
    const value = numberOrZero(chip.val);
    if (!value) return;
    const el = document.createElement('span');
    el.className = `vchip${chip.mineral ? ' mineral' : ''}`;
    el.textContent = `${chip.label}: ${formatOne(value)} ${chip.unit}`;
    container.appendChild(el);
  });
}

async function logMeal() {
  if (!currentResult) return;
  const entry = {
    id: createId(),
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    name: currentResult.food_name,
    thumb: '',
    calories: Math.round(currentResult.calories),
    protein: Math.round(currentResult.protein_g),
    carbs: Math.round(currentResult.carbohydrates_g),
    fat: Math.round(currentResult.fat_g),
    fiber: +formatOne(currentResult.fiber_g),
    sugar: +formatOne(currentResult.sugar_g),
    sodium: Math.round(currentResult.sodium_mg),
    calcium: Math.round(currentResult.minerals?.calcium_mg || 0),
    iron: +formatOne(currentResult.minerals?.iron_mg || 0),
    potassium: Math.round(currentResult.potassium_mg || 0),
    vitD: +formatOne(currentResult.vitamins?.vitamin_d_mcg || 0),
  };

  const log = getTodayLog();
  log.push(entry);
  saveTodayLog(log);
  withTransition(() => {
    addMealCard(entry);
    document.getElementById('logEmpty').hidden = true;
    updateDashboard();
    updateHeroStats();
  });
  resetAnalysisFlow();
  try {
    await syncMeal(entry);
    showToast(`${entry.name} logged`);
  } catch {
    showToast(`${entry.name} logged locally. Sync will retry after reload.`, true);
  }
}

function loadLog() {
  const log = getTodayLog();
  document.getElementById('mealLog').innerHTML = '';
  document.getElementById('logEmpty').hidden = Boolean(log.length);
  log.forEach(addMealCard);
}

function addMealCard(entry) {
  const container = document.getElementById('mealLog');
  const card = document.createElement('div');
  card.className = 'meal-card';
  card.dataset.id = entry.id;

  let thumb;
  if (entry.thumb) {
    thumb = document.createElement('img');
    thumb.className = 'meal-thumb';
    thumb.src = entry.thumb;
    thumb.alt = entry.name;
  } else {
    thumb = document.createElement('div');
    thumb.className = 'meal-thumb meal-thumb-placeholder';
    thumb.textContent = 'Meal';
  }

  const main = document.createElement('div');
  main.className = 'meal-main';
  const info = document.createElement('div');
  info.className = 'meal-info';
  const name = document.createElement('div');
  name.className = 'meal-name';
  name.textContent = entry.name;
  const meta = document.createElement('div');
  meta.className = 'meal-time';
  meta.textContent = entry.time;
  info.append(name, meta);
  main.append(thumb, info);

  const cells = [
    entry.time,
    `${entry.calories} kcal`,
    `${entry.protein}g`,
    `${entry.carbs}g`,
    `${entry.fat}g`,
  ].map(text => {
    const cell = document.createElement('div');
    cell.className = 'meal-cell';
    cell.textContent = text;
    return cell;
  });

  const deleteButton = document.createElement('button');
  deleteButton.className = 'meal-del';
  deleteButton.type = 'button';
  deleteButton.dataset.id = entry.id;
  deleteButton.setAttribute('aria-label', `Remove ${entry.name}`);
  deleteButton.textContent = 'x';
  deleteButton.addEventListener('click', () => deleteMeal(entry.id));

  card.append(main, ...cells, deleteButton);
  container.appendChild(card);
}

async function deleteMeal(id) {
  const log = getTodayLog().filter(meal => meal.id !== id);
  saveTodayLog(log);
  withTransition(() => {
    document.querySelector(`.meal-card[data-id="${id}"]`)?.remove();
    document.getElementById('logEmpty').hidden = Boolean(log.length);
    updateDashboard();
    updateHeroStats();
  });
  try {
    await deleteRemoteMeal(id);
    showToast('Meal removed');
  } catch {
    showToast('Meal removed locally. Sync will retry after reload.', true);
  }
}

function updateDashboard() {
  const log = getTodayLog();
  const goals = getGoals();
  const totals = log.reduce((acc, meal) => {
    acc.calories += meal.calories || 0;
    acc.protein += meal.protein || 0;
    acc.carbs += meal.carbs || 0;
    acc.fat += meal.fat || 0;
    acc.fiber += meal.fiber || 0;
    acc.sugar += meal.sugar || 0;
    acc.sodium += meal.sodium || 0;
    acc.calcium += meal.calcium || 0;
    acc.iron += meal.iron || 0;
    acc.potassium += meal.potassium || 0;
    acc.vitD += meal.vitD || 0;
    return acc;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0, calcium: 0, iron: 0, potassium: 0, vitD: 0 });

  setBar('calBar', totals.calories, goals.calories, 'goalCalVal', `${Math.round(totals.calories)} / ${goals.calories} kcal`);
  setBar('protBar', totals.protein, goals.protein, 'goalProtVal', `${Math.round(totals.protein)}g / ${goals.protein}g`);
  setBar('carbBar', totals.carbs, goals.carbs, 'goalCarbVal', `${Math.round(totals.carbs)}g / ${goals.carbs}g`);
  setBar('fatBar', totals.fat, goals.fat, 'goalFatVal', `${Math.round(totals.fat)}g / ${goals.fat}g`);
  setBar('fiberBar', totals.fiber, goals.fiber, 'goalFiberVal', `${formatOne(totals.fiber)}g / ${goals.fiber}g`);

}

function setBar(barId, val, target, labelId, labelText) {
  const pct = target ? Math.min(100, Math.round((val / target) * 100)) : 0;
  document.getElementById(barId).style.width = `${pct}%`;
  document.getElementById(labelId).textContent = labelText;
}

function updateHeroStats() {
  const log = getTodayLog();
  const cal = log.reduce((sum, meal) => sum + (meal.calories || 0), 0);
  const protein = log.reduce((sum, meal) => sum + (meal.protein || 0), 0);
  document.getElementById('heroMealsLogged').textContent = log.length;
  document.getElementById('heroCalories').textContent = Math.round(cal);
  document.getElementById('heroProtein').textContent = `${Math.round(protein)}g`;
  const carbs = log.reduce((sum, meal) => sum + (meal.carbs || 0), 0);
  const fat = log.reduce((sum, meal) => sum + (meal.fat || 0), 0);
  const fiber = log.reduce((sum, meal) => sum + (meal.fiber || 0), 0);
  setTextIfPresent('heroCarbs', `${Math.round(carbs)}g`);
  setTextIfPresent('heroFat', `${Math.round(fat)}g`);
  setTextIfPresent('heroFiber', `${Math.round(fiber)}g`);
}

function setTextIfPresent(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function formatOne(value) {
  return String(+numberOrZero(value).toFixed(1));
}

let toastTimer = null;
function showToast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.style.borderColor = isError ? '#e86d54' : 'var(--green)';
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
