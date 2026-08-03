import {
  degreeToRadian,
  eastNorthUpToFixedFrame,
  geodeticToVector3,
  radianToDegree,
  vector3ToGeodetic,
} from "@navaramap/three";
import { Matrix4, Vector3 } from "three";

/** 経度・緯度（度）と楕円体高（m）。 */
export type Geodetic = { lng: number; lat: number; height: number };

/**
 * 東京付近のジオイド高（m）。
 * 標高（東京湾平均海面基準, T.P.）と楕円体高の差はおよそ +37 m。
 * 地形データが読み込まれるまでのフォールバックとして使う。
 * 実際の高さは可能なかぎり `sampleTerrainHeight()` から取る。
 */
export const TOKYO_GEOID_HEIGHT = 37;

/** 度指定の測地座標を ECEF 座標に変換する。 */
export function toEcef(g: Geodetic): Vector3 {
  return geodeticToVector3({
    lng: degreeToRadian(g.lng),
    lat: degreeToRadian(g.lat),
    height: g.height,
  }) as unknown as Vector3;
}

/**
 * 指定地点における East-North-Up の接平面フレームを返す。
 * Navara の `matrixWorld` に渡すと、その配下の座標を
 * 「東 x / 北 y / 上 z（メートル）」で書けるようになる。
 */
export function enuFrame(g: Geodetic): Matrix4 {
  return eastNorthUpToFixedFrame(toEcef(g)) as unknown as Matrix4;
}

/** 2 地点間の直線距離（m）。音の遅延計算に使う。 */
export function distanceMeters(a: Geodetic, b: Geodetic): number {
  return toEcef(a).distanceTo(toEcef(b));
}

/** ECEF 座標を度指定の測地座標に戻す。クリックした地点を求めるのに使う。 */
export function fromEcef(v: Vector3): Geodetic {
  const lle = vector3ToGeodetic(v as any);
  return {
    lng: radianToDegree(lle.lng),
    lat: radianToDegree(lle.lat),
    height: lle.height,
  };
}

/**
 * ENU フレーム原点から見たローカル座標 (m) を求める。
 * 打ち上げ地点の緯度経度をフレーム内のローカル座標へ落とし込む。
 */
export function enuOffset(origin: Geodetic, target: Geodetic): Vector3 {
  const inv = new Matrix4().copy(enuFrame(origin)).invert();
  return toEcef(target).applyMatrix4(inv);
}
