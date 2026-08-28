<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, setToken } from '../api';
import { useToast } from '../toast';

const router = useRouter();
const toast = useToast();
const username = ref('');
const password = ref('');
const loading = ref(false);

async function onLogin() {
  if (!username.value.trim() || !password.value) {
    toast.warn('请输入账号和密码');
    return;
  }
  loading.value = true;
  try {
    const data = await api.login(username.value.trim(), password.value);
    setToken(data.token);
    toast.success('登录成功');
    router.push('/');
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card md-card">
      <div class="login-logo">C</div>
      <h2 class="login-title">CaptureHub</h2>
      <p class="login-sub">直播录制系统</p>
      <div class="login-form">
        <div class="field">
          <label class="label">账号</label>
          <input
            v-model="username"
            class="input"
            placeholder="请输入账号"
            autocomplete="username"
            @keyup.enter="onLogin"
          />
        </div>
        <div class="field">
          <label class="label">密码</label>
          <input
            v-model="password"
            class="input"
            type="password"
            placeholder="请输入密码"
            autocomplete="current-password"
            @keyup.enter="onLogin"
          />
        </div>
        <button
          class="btn btn-primary login-btn"
          :disabled="loading"
          @click="onLogin"
        >
          {{ loading ? '登录中…' : '登录' }}
        </button>
      </div>
      <div class="login-hint">初始账号: capturehub / 初始密码: admin</div>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: var(--background);
}
.login-card {
  width: 100%;
  max-width: 360px;
  padding: 36px 28px;
  border-radius: var(--radius);
  text-align: center;
  animation: loginIn 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}
@keyframes loginIn {
  from { opacity: 0; transform: translateY(20px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.login-logo {
  width: 60px;
  height: 60px;
  border-radius: 20px;
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 26px;
  background: linear-gradient(135deg, var(--primary), var(--primary-hover));
  color: var(--primary-foreground);
  box-shadow: var(--elev-3);
  margin: 0 auto 18px;
}
.login-title {
  margin: 0;
  font-size: 24px;
  font-weight: 800;
  color: var(--foreground);
  letter-spacing: -0.02em;
}
.login-sub {
  margin: 4px 0 28px;
  font-size: 13px;
  color: var(--muted-foreground);
}
.login-form {
  text-align: left;
}
.login-btn {
  width: 100%;
  margin-top: 8px;
  height: 46px;
  font-size: 15px;
}
.login-hint {
  margin-top: 18px;
  font-size: 11.5px;
  color: var(--muted-foreground);
  opacity: 0.8;
}
</style>
