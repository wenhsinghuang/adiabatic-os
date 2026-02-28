https://claude.ai/chat/07b66dd9-6f1d-48c8-a192-0d12fcacdd74

https://claude.ai/code/session_011CUeuaTS3jqepJFmYoGztL

https://claude.ai/chat/f54b6cd5-9fb4-4f3d-bff5-b571540bd9b1
# User Guide

**Desktop:**

1. 下載 [ActivityWatch](https://activitywatch.net/)
2. 安裝 browser extension (Chrome/Firefox)
3. 下載我們的 sync app（待開發）- 背景上傳到 Supabase

**iOS:**

1. TestFlight 安裝 app（待開發）
2. 授權 Screen Time + Location + Motion permissions
3. 設定 locker 預設（常用 app + 意圖）

**Oura:**

1. 登入 [Oura Cloud](https://cloud.ouraring.com/)
2. 生成 Personal Access Token
3. 在 iOS app 輸入 token（或 web dashboard）


### PoC

建簡單 dashboard：

**Web UI (Supabase + React):**

javascript

```javascript
// 查詢最近 events
const { data } = await supabase
  .from('events')
  .select('*')
  .order('started_at', { ascending: false })
  .limit(20)
```

或用 Supabase Dashboard 直接看表格。

PoC 階段 Supabase UI 夠用。

### Data source

├─ Desktop: ActivityWatch 
	`aw-watcher-window`
	`aw-watcher-afk`

├─ Mobile: iOS native app (Testflight) -> native screen time
	expo + rn
	- 用戶可以 disable locker 功能 (opt-out)
	- locker feature: app (只開他) + intention tag (work, entertain, other-typing) + time
	- track hourly level data, 通過其他資訊逆推
	- track Motion Activity + GPS: 用來判斷移動 娛樂 買菜 買飯

```
- **所有 app 預設鎖定**
- **要用 app 時：**
    - 選擇 app (FamilyActivityPicker)
    - 標記意圖 (work/entertainment/other)
    - 設定時長
- **Apple Screen Time API 自動記錄該 app 使用時長**
- **Cross-reference：**
    - 你的記錄：Instagram, work, 30min
    - Apple 數據：Instagram, 實際用了 28min
    - 結論：有 2min gap，可能分心
      

這會影響使用嗎?      
**每次用 app 都要：**

1. 選 app
2. 標記意圖
3. 設時長

**解決方案：**

1. **快速預設** - 常用 app 存預設（Instagram = entertainment, 15min）
2. **Smart defaults** - AI 根據時間/context 推薦
3. **批次解鎖** - 一次解鎖多個 app（工作模式 = VSCode + Chrome + Slack）
4. **緊急繞過** - 長按可暫時解鎖（但會記錄為 "unplanned"）

關鍵：讓「有意圖的使用」流暢，讓「無意識滑手機」有摩擦。

我是想要
app (只開他) + intention tag (work, entertain, other-typing) + time
三個遠項能直接點擊 toggle 不用選單


```

```
DeviceActivityReport 可取得 `.hourly` 或 `.daily` 粒度的數據，包含每個 app 的使用時長 [Medium](https://letvar.medium.com/time-after-screen-time-part-2-the-device-activity-report-extension-10eeeb595fbd)[Medium](https://kushwaha03.medium.com/the-screen-time-api-and-whats-new-in-screen-time-api-50a1404c130e)

**iOS Screen Time API 能提供**：

- 每小時/每日 app 使用時長
- 每個 app 的詳細數據
- 可在 app 內顯示

```

├─ Browser: ActivityWatch Chrome Extension 
	`aw-watcher-web_hostname`

└─ Health: Oura API

Desktop: need a App to upload ActivityWatch data

### Cloud

* **API**: Supabase Edge Functions
	* 免費額度: 500K invocations/月
* DB: 
	* Supabase 免費層：
		- 500MB 存儲
		- **讀寫無限制**
		- 50K MAU
		- 2GB 傳輸/月



Raw data schema

# Complete Data Source Schemas

## ActivityWatch

**Window Events:**

```json
{
  "timestamp": "2025-10-13T10:00:00Z",
  "duration": 1800.5,
  "data": {
    "app": "Google Chrome",
    "title": "GitHub - ActivityWatch Documentation"
  }
}
```

**AFK Events:**

```json
{
  "timestamp": "2025-10-13T12:00:00Z",
  "duration": 180,
  "data": {
    "status": "afk"
  }
}
```

**Web Events:**

```json
{
  "timestamp": "2025-10-13T14:30:00Z",
  "duration": 450,
  "data": {
    "url": "https://github.com/ActivityWatch/activitywatch",
    "title": "ActivityWatch/activitywatch: Records what you do",
    "audible": false,
    "incognito": false
  }
}
```

## iOS Manual (Your App)

**Unlock Event (our design):**

**completed**: 時間到了（planned_duration 用完） **bypassed**: 用戶提前強制解鎖（沒標記意圖/時長）
```json
{
  "timestamp": "2025-10-13T16:00:00Z",
  "duration": 1800,
  "data": {
    "app_token": "opaque_token_abc123", // 從 FamilyActivityPicker 用戶選擇時建立映射
    "app_name": "Instagram",  // from FamilyActivityPicker Label
    "bundle_id": "com.instagram.app",  // if available
    "intention": "work",  // work | entertainment | other
    "planned_duration": 1800,
    "actual_duration": 1750,  // from Screen Time API
    "completed": true,
    "bypassed": false
  }
}
```

**Screen Time Verification:**

```json
{
  "hour": "2025-10-13T14:00:00Z",
  "apps": [
    {
      "token": "opaque_token_abc123",
      "duration": 1800  // seconds in this hour
    },
    {
      "token": "opaque_token_def456", 
      "duration": 600
    }
  ]
}
```

**CMMotionActivity raw data:**

```swift
// iOS CMMotionActivity object properties
activity.stationary: Bool
activity.walking: Bool
activity.running: Bool
activity.automotive: Bool
activity.cycling: Bool
activity.unknown: Bool
activity.confidence: CMMotionActivityConfidence  // low, medium, high
activity.startDate: Date
```

Example:

```json
{
  "stationary": false,
  "walking": true,
  "running": false,
  "automotive": false,
  "cycling": false,
  "unknown": false,
  "confidence": "high",
  "startDate": "2025-10-13T14:30:00Z"
}
```

**CLLocation raw data:**

```swift
location.coordinate.latitude: Double
location.coordinate.longitude: Double
location.altitude: Double
location.horizontalAccuracy: Double
location.verticalAccuracy: Double
location.course: Double  // heading
location.speed: Double  // m/s
location.timestamp: Date
```

Example:

```json
{
  "latitude": 25.033,
  "longitude": 121.5654,
  "altitude": 10.5,
  "horizontalAccuracy": 65.0,
  "verticalAccuracy": 10.0,
  "course": 180.5,
  "speed": 1.2,
  "timestamp": "2025-10-13T14:30:00Z"
}
```

## Oura API

**Daily Sleep:**

```json
{
  "id": "uuid",
  "day": "2025-10-13",
  "score": 85,
  "contributors": {
    "deep_sleep": 99,
    "efficiency": 98,
    "latency": 81,
    "rem_sleep": 95,
    "restfulness": 75,
    "timing": 88,
    "total_sleep": 92
  },
  "bedtime_start": "2025-10-12T23:30:00Z",
  "bedtime_end": "2025-10-13T07:15:00Z",
  "deep_sleep_duration": 7200,
  "rem_sleep_duration": 5400,
  "light_sleep_duration": 14400,
  "total_sleep_duration": 27000
}
```

**Daily Readiness:**

```json
{
  "id": "uuid",
  "day": "2025-10-13",
  "score": 87,
  "contributors": {
    "activity_balance": 80,
    "body_temperature": 100,
    "hrv_balance": 84,
    "previous_night": 88,
    "resting_heart_rate": 94,
    "sleep_balance": 85
  }
}
```

**Daily Activity:**

```json
{
  "id": "uuid",
  "day": "2025-10-13",
  "score": 82,
  "active_calories": 450,
  "steps": 8500,
  "total_calories": 2400,
  "high_activity_time": 3600,
  "medium_activity_time": 5400,
  "low_activity_time": 7200,
  "sedentary_time": 28800
}
```

**Heart Rate:**

```json
{
  "bpm": 62,
  "source": "sleep",
  "timestamp": "2025-10-13T02:30:00Z"
}
```

**Workout:**

```json
{
  "id": "uuid",
  "activity": "cycling",
  "calories": 450,
  "day": "2025-10-13",
  "distance": 15000,
  "start_datetime": "2025-10-13T10:00:00Z",
  "end_datetime": "2025-10-13T11:30:00Z",
  "intensity": "moderate"
}
```

**Daily SpO2:**

```json
{
  "id": "uuid",
  "day": "2025-10-13",
  "spo2_percentage": {
    "average": 96.5
  }
}
```

---

# DB Schema Design

Safety: multi-tenent + RLS

- Raw data 存 events.data jsonb
- Location 獨立表
同意。移除 `timezone` 欄位，用 GPS 反推即可。

最終 schema：

```sql
-- Users
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Events (all time-series data)
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users NOT NULL,
  source text NOT NULL,
  source_event_id text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  data jsonb NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Location + Motion
CREATE TABLE location_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users NOT NULL,
  latitude decimal(10, 8) NOT NULL,
  longitude decimal(11, 8) NOT NULL,
  accuracy decimal(10, 2),
  altitude decimal(8, 2),
  speed decimal(5, 2),
  course decimal(5, 2),
  timestamp timestamptz NOT NULL,
  activity_type text,
  activity_confidence text,
  created_at timestamptz DEFAULT now()
);

-- App tokens
CREATE TABLE app_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users NOT NULL,
  token text NOT NULL,
  app_name text NOT NULL,
  bundle_id text,
  last_used_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, token)
);

-- Sync status
CREATE TABLE sync_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users NOT NULL,
  source text NOT NULL,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, source)
);

-- Indexes
CREATE INDEX idx_events_user_time ON events(user_id, started_at DESC);
CREATE INDEX idx_events_source ON events(user_id, source, started_at DESC);
CREATE INDEX idx_events_data_gin ON events USING gin(data);
CREATE UNIQUE INDEX idx_events_dedup ON events(user_id, source, source_event_id) 
  WHERE source_event_id IS NOT NULL;

CREATE INDEX idx_location_user_time ON location_events(user_id, timestamp DESC);
CREATE INDEX idx_location_activity ON location_events(user_id, activity_type, timestamp DESC);

CREATE INDEX idx_app_tokens_user ON app_tokens(user_id);

-- RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_policy ON users FOR ALL USING (auth.uid() = id);
CREATE POLICY events_policy ON events FOR ALL USING (auth.uid() = user_id);
CREATE POLICY location_policy ON location_events FOR ALL USING (auth.uid() = user_id);
CREATE POLICY tokens_policy ON app_tokens FOR ALL USING (auth.uid() = user_id);
CREATE POLICY sync_policy ON sync_status FOR ALL USING (auth.uid() = user_id);
```

