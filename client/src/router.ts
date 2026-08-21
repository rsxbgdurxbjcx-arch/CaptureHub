import { createRouter, createWebHistory } from 'vue-router';
import StreamersView from './views/StreamersView.vue';
import FilesView from './views/FilesView.vue';
import PostProcessView from './views/PostProcessView.vue';
import SettingsView from './views/SettingsView.vue';
import LoginView from './views/LoginView.vue';
import { getToken } from './api';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView, meta: { title: '登录', public: true } },
    { path: '/', redirect: '/streamers' },
    { path: '/streamers', component: StreamersView, meta: { title: '主播' } },
    { path: '/files', component: FilesView, meta: { title: '文件' } },
    { path: '/postprocess', component: PostProcessView, meta: { title: '后处理' } },
    { path: '/settings', component: SettingsView, meta: { title: '设置' } },
  ],
});

// 导航守卫：未登录跳转登录页
router.beforeEach((to, _from, next) => {
  const token = getToken();
  if (!to.meta.public && !token) {
    next('/login');
  } else if (to.path === '/login' && token) {
    next('/');
  } else {
    next();
  }
});
