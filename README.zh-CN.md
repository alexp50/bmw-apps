# AlexP50 宝马 iDrive 7 应用

[English](README.md) · [简体中文](README.zh-CN.md)

这是一组面向宝马 MGU / iDrive 7 的全屏应用，可通过 MGU Store 管理。功能涉及车辆数据、行程、保养、泊车和舒适设置，具体可用项取决于车型、装备和固件。

翻译者：抖音「小白科技杂物社」 · BiliBili「小白151」 · GitHub [JackieZ123430](https://github.com/JackieZ123430)。

## 简中应用

| 应用 | 包 ID | 用途 |
| --- | --- | --- |
| 氛围灯工作室 | `ambient_studio_full` | 驾驶模式配色和灯光提醒 |
| 颗粒捕集器监测 | `dpf_monitor` | 查看柴油颗粒捕集器的积碳、压差、温度和再生记录 |
| 抬头显示助手 | `drive_hud_full` | 设置 HUD 转向箭头、运动挡位和转速、换挡及暖机提示 |
| 仪表夜视 | `front_camera_cluster` | 控制宝马夜视或泊车摄像头画面在仪表中的投射 |
| 绿灯起步提醒 | `green_light_alert` | 查看 KAFAS 红绿灯信号和区域可用性 |
| 热点工作室 | `hotspot_studio` | 管理华为 LTE 代理及限时单客户端 ENET 网关 |
| 泊车距离 | `parking_clearance` | 查看 PDC 距离、转向轨迹和悬架姿态 |
| 后排舒适控制 | `rear_comfort` | G12 后排空调、座椅、按摩、遮阳帘及娱乐控制 |
| 车身高度工作室 | `ride_height` | 查看悬架高度与 VDP 控制状态 |
| 行程电脑 | `road_trip_computer` | 记录行程、油耗和燃油费用，支持主页小组件 |
| 自动启停状态 | `start_stop_insight` | 查看启停判定、近期变化及用电负载 |
| 车辆遥测 | `telemetry_studio` | 分类显示动力、热管理、底盘、轮胎和电气数据 |
| 车辆健康中心 | `vehicle_health` | 查看胎压、油液、保养、检查控制和当前故障 |
| 车辆网络 | `vehicle_network` | 观测 MGU 网络接口、网络设备及电脑 IPv4 配置 |
| xDrive 动力分配 | `xdrive_studio` | 查看前后轴扭矩、车轮滑差和车辆动态 |

简中构建覆盖应用名称、主要页面、原生设置及行程电脑主页小组件。主界面右上角和原生设置页使用现有构建工具的汉化署名。车型信号标识、诊断代码、单位、终端命令及动态读取的 BMW 诊断目录字段沿用原文。Waze HUD 和独立的 Parked BMW 安卓应用未纳入本次简中范围。

## 构建简中版

在源码根目录准备从自己车机提取的 `oap-sdk/`，然后指定应用 ID。Windows 下使用 `python`。

```sh
python3 kit/tools/build.py --language zh-CN road_trip_computer vehicle_health telemetry_studio parking_clearance
```

产物位于 `dist/`，默认带 `-zh.cn.5` 语言后缀。Store 源码构建若要求包内版本和 `app.json` 一致，可加入 `--keep-version`。英文和简中使用相同应用 ID。BMW SDK 及含有该 SDK 的构建产物请留在本地。

## 原版安装与依赖

在 MGU Store 的设置中添加 `alexp50/bmw-apps`，来源类型选 Releases，再刷新来源。上游发布目录随包列出 GPU 渲染器、旋钮控制和各应用的辅助组件。原版安装、网络网关、控制器及显示故障排查见 [上游说明](https://github.com/AlexP50/bmw-apps)。简中源码和上游 Releases 是两个独立来源。

## 来源与使用

- [AlexP50 原仓库](https://github.com/AlexP50/bmw-apps)
- [简中 fork](https://github.com/JackieZ123430/alexp50-bmw-apps-cn)
- [MGU Store](https://github.com/robertnisipeanu/mgu-store)
- 中文字形使用 Noto Sans SC，许可见 [SIL Open Font License](kit/runtime/fonts/OFL-NotoSansSC.txt)。

这是社区项目，与 BMW AG 无关联。请在停车时配置和测试，并以车上实测状态确认适用性。
