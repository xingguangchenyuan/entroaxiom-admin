<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { startCoreGlow } from "@/utils/coreGlow";

defineOptions({
  name: "LoginGalaxy"
});

const canvasRef = ref<HTMLCanvasElement>();
let stop: (() => void) | null = null;

onMounted(() => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  try {
    // 尺寸由 CSS 决定；小屏下父级 .img 被隐藏（尺寸 0）时引擎自己暂停
    stop = startCoreGlow(canvas);
  } catch {
    // canvas 2D 不可用：只是少一块装饰，不影响登录
  }
});

onBeforeUnmount(() => {
  stop?.();
  stop = null;
});
</script>

<template>
  <canvas ref="canvasRef" class="login-galaxy" aria-hidden="true" />
</template>

<style scoped>
.login-galaxy {
  display: block;

  /* 正方形：不超过所在列的宽度，也不超过视口高度（留出上下边距），矮屏幕上也完整显示 */
  width: min(100%, 760px, calc(100vh - 96px));
  aspect-ratio: 1;
}

@supports (height: 100dvh) {
  .login-galaxy {
    width: min(100%, 760px, calc(100dvh - 96px));
  }
}
</style>
