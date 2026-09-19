<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import Toast from './Toast.vue';
import ConfirmDialog from './ConfirmDialog.vue';

const route = useRoute();
const isLogin = computed(() => route.path === '/login');
</script>

<template>
  <div v-if="isLogin">
    <router-view />
    <Toast />
    <ConfirmDialog />
  </div>
  <div v-else class="app-shell">
    <main class="page">
      <router-view v-slot="{ Component }">
        <Transition name="page" mode="out-in">
          <component :is="Component" />
        </Transition>
      </router-view>
    </main>

    <nav class="tabbar">
      <router-link to="/streamers" class="tab">
        <span class="tab-indicator" />
        <span class="tab-ico">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </span>
        <span class="tab-label">主播</span>
      </router-link>
      <router-link to="/files" class="tab">
        <span class="tab-indicator" />
        <span class="tab-ico">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2"/>
            <path d="M7 3v18"/>
            <path d="M3 7.5h4"/>
            <path d="M3 12h18"/>
            <path d="M3 16.5h4"/>
            <path d="M17 3v18"/>
            <path d="M17 7.5h4"/>
            <path d="M17 16.5h4"/>
          </svg>
        </span>
        <span class="tab-label">文件</span>
      </router-link>
      <router-link to="/postprocess" class="tab">
        <span class="tab-indicator" />
        <span class="tab-ico">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="8" height="8" x="3" y="3" rx="2"/>
            <path d="M7 11v4a2 2 0 0 0 2 2h4"/>
            <rect width="8" height="8" x="13" y="13" rx="2"/>
          </svg>
        </span>
        <span class="tab-label">后处理</span>
      </router-link>
      <router-link to="/settings" class="tab">
        <span class="tab-indicator" />
        <span class="tab-ico">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </span>
        <span class="tab-label">设置</span>
      </router-link>
    </nav>

    <Toast />
    <ConfirmDialog />
  </div>
</template>
