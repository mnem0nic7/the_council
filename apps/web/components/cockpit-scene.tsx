"use client";

import { Float, MeshDistortMaterial, Sphere, Stars, Torus } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";

export function CockpitScene() {
  return (
    <div className="absolute inset-0">
      <Canvas camera={{ position: [0, 0, 9], fov: 55 }}>
        <color attach="background" args={["#020710"]} />
        <ambientLight intensity={0.9} />
        <pointLight color="#76f4ff" intensity={12} position={[4, 6, 8]} />
        <pointLight color="#f7b955" intensity={4} position={[-5, -3, 4]} />
        <Stars radius={160} depth={80} count={5000} factor={4} saturation={0} fade speed={0.7} />
        <Float speed={1.4} rotationIntensity={0.4} floatIntensity={0.6}>
          <Torus args={[2.8, 0.08, 32, 200]} rotation={[1.3, 0.6, 0]}>
            <meshStandardMaterial color="#5af4ff" emissive="#2dd2ff" emissiveIntensity={2.6} />
          </Torus>
        </Float>
        <Float speed={1.1} rotationIntensity={0.3} floatIntensity={0.4}>
          <Sphere args={[1.25, 64, 64]} position={[0, 0, -2]}>
            <MeshDistortMaterial
              color="#0f2334"
              emissive="#0f8c9f"
              emissiveIntensity={1.3}
              transparent
              opacity={0.42}
              distort={0.32}
              speed={2.5}
              roughness={0.1}
            />
          </Sphere>
        </Float>
      </Canvas>
    </div>
  );
}

